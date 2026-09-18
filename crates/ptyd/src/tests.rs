//! 端到端：进程内起真 ptyd，经真 UDS 客户端驱动真 PTY 与真子进程。

use std::io::{Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::sync::mpsc::Receiver;
use std::sync::Arc;
use std::time::{Duration, Instant};

use coflux_protocol::ptyd::{
    encode_ptyd_record, split_ptyd_payload, PtydMessage, PtydRequest, PtydRequestEnvelope,
    PTYD_LOGICAL_CLIENT_LIMIT, PTYD_RING_CAPACITY, TERMINAL_DATA_DIR,
};

use crate::client::{PtydClient, PtydError, SubscriptionEvent};
use crate::ring;
use crate::server::{Ptyd, PtydConfig};

fn temp_home(name: &str) -> PathBuf {
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos()
        % 1_000_000_000;
    // socket 路径有 104 字节上限，名字保持短。
    std::env::temp_dir().join(format!("cfp-{name}-{}-{nonce}", std::process::id() % 100_000))
}

fn start(name: &str) -> (Ptyd, Arc<PtydClient>, PathBuf) {
    let home = temp_home(name);
    let ptyd = Ptyd::start(PtydConfig::for_home(&home)).expect("ptyd 应能启动");
    let client = PtydClient::connect(ptyd.socket_path()).expect("应能连上 ptyd");
    (ptyd, client, home)
}

fn env() -> Vec<(String, String)> {
    vec![
        ("PATH".into(), "/usr/bin:/bin".into()),
        ("HOME".into(), "/tmp".into()),
        ("TERM".into(), "xterm-256color".into()),
    ]
}

fn spawn(client: &PtydClient, session_id: &str, argv: &[&str]) -> i32 {
    client.open(session_id, 24, 80, "{\"label\":true}").expect("open 应成功");
    client
        .spawn(session_id, argv.iter().map(|arg| (*arg).to_string()).collect(), env(), "/tmp")
        .expect("spawn 应成功")
}

fn wait_until(what: &str, timeout: Duration, mut condition: impl FnMut() -> bool) {
    let deadline = Instant::now() + timeout;
    while !condition() {
        assert!(Instant::now() < deadline, "等待超时：{what}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn wait_exit(client: &PtydClient, session_id: &str) -> i32 {
    let mut code = None;
    wait_until("session 退出", Duration::from_secs(10), || {
        code = client
            .list()
            .unwrap()
            .into_iter()
            .find(|info| info.session_id == session_id)
            .and_then(|info| info.exit_code);
        code.is_some()
    });
    code.unwrap()
}

fn output_offset(client: &PtydClient, session_id: &str) -> u64 {
    client
        .list()
        .unwrap()
        .into_iter()
        .find(|info| info.session_id == session_id)
        .map(|info| info.output_offset)
        .unwrap_or(0)
}

fn collect_output(events: &Receiver<SubscriptionEvent>, at_least: usize, timeout: Duration) -> Vec<u8> {
    let deadline = Instant::now() + timeout;
    let mut seen = Vec::new();
    while seen.len() < at_least {
        let remaining = deadline.saturating_duration_since(Instant::now());
        assert!(!remaining.is_zero(), "等待输出超时，已收到 {:?}", String::from_utf8_lossy(&seen));
        match events.recv_timeout(remaining) {
            Ok(SubscriptionEvent::Output { data, .. }) => seen.extend_from_slice(&data),
            Ok(SubscriptionEvent::Exited { .. }) => break,
            Err(error) => panic!("订阅流断开：{error}"),
        }
    }
    seen
}

fn finish(ptyd: Ptyd, home: PathBuf) {
    ptyd.terminate();
    let _ = std::fs::remove_dir_all(home);
}

#[test]
fn hello_advertises_v1_ops_and_waitpid_reports_the_real_exit_code() {
    let (ptyd, client, home) = start("exit");
    assert_eq!(client.hello().protocol_version, 1);
    for op in ["open", "spawn", "subscribe", "write", "checkpoint", "shutdown"] {
        assert!(client.supports(op), "缺少 v1 op {op}");
    }
    let pid = spawn(&client, "exit-7", &["sh", "-c", "exit 7"]);
    assert!(pid > 0);
    let events = client.subscribe("exit-7", 0).unwrap();
    let mut exit_code = None;
    let deadline = Instant::now() + Duration::from_secs(10);
    while exit_code.is_none() {
        match events.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            Ok(SubscriptionEvent::Exited { exit_code: code, .. }) => exit_code = Some(code),
            Ok(SubscriptionEvent::Output { .. }) => {}
            Err(error) => panic!("应收到 Exited：{error}"),
        }
    }
    assert_eq!(exit_code, Some(7), "waitpid 必须给出真实退出码");
    assert_eq!(wait_exit(&client, "exit-7"), 7);
    // 退出后 session 仍在（等 supervisor 拿走退出事实），remove 之后才消失，文件随之 unlink。
    let path = home.join(TERMINAL_DATA_DIR).join(ring::file_name_for("exit-7"));
    assert!(path.exists());
    client.remove("exit-7").unwrap();
    assert!(client.list().unwrap().is_empty());
    assert!(!path.exists(), "remove 后 ring 文件必须已 unlink");
    finish(ptyd, home);
}

#[test]
fn read_loop_stops_at_the_checkpoint_offset_even_with_no_subscriber() {
    let (ptyd, client, home) = start("stop");
    let session = "yes";
    spawn(&client, session, &["yes"]);
    // 没有 checkpoint 时 X=0：ring 只能装到 4 MiB，然后 ptyd 必须停止读而不是覆盖偏移 0。
    wait_until("ring 填到容量", Duration::from_secs(20), || output_offset(&client, session) >= PTYD_RING_CAPACITY);
    assert_eq!(output_offset(&client, session), PTYD_RING_CAPACITY);
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(output_offset(&client, session), PTYD_RING_CAPACITY, "没有 checkpoint 就不许越过偏移 0 继续写");
    let (at, head) = client.read(session, 0, 8).unwrap();
    assert_eq!((at, head.as_slice()), (0, &b"y\ny\ny\ny\n"[..]), "偏移 0 的字节仍在");
    let alive = client.list().unwrap().into_iter().find(|info| info.session_id == session).unwrap();
    assert_eq!(alive.exit_code, None, "shell 只是被内核 PTY 缓冲挡住，没有死");

    // checkpoint 把 X 推到 2 MiB：预算重新出现，读循环继续，但 ring 起点永不越过 2 MiB。
    client.checkpoint(session, 2 * 1024 * 1024, b"blob").unwrap();
    wait_until("checkpoint 后继续读", Duration::from_secs(10), || output_offset(&client, session) > PTYD_RING_CAPACITY);
    wait_until("再次停在 X + CAP", Duration::from_secs(20), || output_offset(&client, session) >= 6 * 1024 * 1024);
    std::thread::sleep(Duration::from_millis(200));
    assert_eq!(output_offset(&client, session), 6 * 1024 * 1024);
    let info = client.list().unwrap().into_iter().find(|info| info.session_id == session).unwrap();
    assert_eq!(info.ring_start, 2 * 1024 * 1024, "ring 起点停在 checkpoint 偏移，不再前进");
    assert_eq!(info.checkpoint_offset, Some(2 * 1024 * 1024));
    let blob = client.blob(session).unwrap();
    assert_eq!(blob, Some((2 * 1024 * 1024, b"blob".to_vec())));

    client.kill(session).unwrap();
    wait_exit(&client, session);
    client.remove(session).unwrap();
    finish(ptyd, home);
}

#[test]
fn logical_client_cap_rejects_new_identities_but_keeps_serving_registered_ones() {
    let (ptyd, client, home) = start("cap");
    let session = "cat";
    spawn(&client, session, &["cat"]);
    let mut input = client.input_channel().unwrap();
    for index in 0..PTYD_LOGICAL_CLIENT_LIMIT {
        let written = input.write(session, &format!("client-{index}"), 1, b"a").unwrap();
        assert_eq!((written.applied_through_seq, written.duplicate), (1, false));
    }
    let refused = input.write(session, "client-one-too-many", 1, b"a").unwrap_err();
    assert_eq!(refused.code(), "logical_client_limit");
    // 已登记 identity 照常推进；重复 seq 判 duplicate、同 seq 不同 payload 判 collision、跳号判 gap。
    let advanced = input.write(session, "client-0", 2, b"b").unwrap();
    assert_eq!((advanced.applied_through_seq, advanced.duplicate), (2, false));
    let duplicate = input.write(session, "client-0", 2, b"b").unwrap();
    assert_eq!((duplicate.applied_through_seq, duplicate.duplicate), (2, true));
    assert_eq!(input.write(session, "client-0", 2, b"c").unwrap_err().code(), "input_seq_collision");
    assert_eq!(input.write(session, "client-0", 4, b"d").unwrap_err().code(), "input_seq_gap");
    let cursors = client.cursors(session).unwrap();
    assert_eq!(cursors.len(), PTYD_LOGICAL_CLIENT_LIMIT);
    let zero = cursors.iter().find(|cursor| cursor.client_instance_id == "client-0").unwrap();
    assert_eq!((zero.seq, zero.data_hex.as_str()), (2, "62"));
    client.kill(session).unwrap();
    wait_exit(&client, session);
    client.remove(session).unwrap();
    finish(ptyd, home);
}

#[test]
fn resize_log_records_the_output_offset_at_each_change() {
    let (ptyd, client, home) = start("resize");
    let session = "printf";
    spawn(&client, session, &["sh", "-c", "printf hello; sleep 30"]);
    let events = client.subscribe(session, 0).unwrap();
    assert_eq!(collect_output(&events, 5, Duration::from_secs(10)), b"hello");
    client.resize(session, 30, 100).unwrap();
    let log = client.resizes(session).unwrap();
    assert_eq!(log.len(), 1);
    assert_eq!((log[0].offset, log[0].rows, log[0].cols), (5, 30, 100));
    let info = client.list().unwrap().into_iter().find(|info| info.session_id == session).unwrap();
    assert_eq!((info.rows, info.cols), (30, 100));
    assert!(info.tty.starts_with("/dev/"), "open 必须给出真实设备路径：{}", info.tty);
    client.kill(session).unwrap();
    wait_exit(&client, session);
    client.remove(session).unwrap();
    finish(ptyd, home);
}

#[test]
fn subscribe_replays_the_ring_from_the_offset_then_streams_live_output() {
    let (ptyd, client, home) = start("replay");
    let session = "abc";
    spawn(&client, session, &["sh", "-c", "printf abc; sleep 0.3; printf def; sleep 30"]);
    wait_until("前三个字节", Duration::from_secs(10), || output_offset(&client, session) == 3);
    let events = client.subscribe(session, 1).unwrap();
    match events.recv_timeout(Duration::from_secs(5)).unwrap() {
        SubscriptionEvent::Output { from_offset, data } => {
            assert_eq!((from_offset, data.as_slice()), (1, &b"bc"[..]), "先补发 ring 里 [1, 3)");
        }
        other => panic!("应先补发 ring：{other:?}"),
    }
    match events.recv_timeout(Duration::from_secs(5)).unwrap() {
        SubscriptionEvent::Output { from_offset, data } => {
            assert_eq!((from_offset, data.as_slice()), (3, &b"def"[..]), "再实时推送");
        }
        other => panic!("应实时推送：{other:?}"),
    }
    assert!(client.subscribe(session, 99).is_err(), "超前的偏移必须拒绝");
    client.kill(session).unwrap();
    match events.recv_timeout(Duration::from_secs(10)).unwrap() {
        SubscriptionEvent::Exited { final_offset, .. } => assert_eq!(final_offset, 6),
        other => panic!("kill 后应收到 Exited：{other:?}"),
    }
    client.remove(session).unwrap();
    finish(ptyd, home);
}

#[test]
fn terminal_data_files_are_private_unlinked_at_session_end_and_swept_at_startup() {
    let home = temp_home("files");
    let data_dir = home.join(TERMINAL_DATA_DIR);
    std::fs::create_dir_all(&data_dir).unwrap();
    // 上一次 ptyd 被 kill 留下的文件。
    let stale = data_dir.join("s-00000000000000000000000000000000.ring");
    std::fs::write(&stale, b"stale").unwrap();
    let ptyd = Ptyd::start(PtydConfig::for_home(&home)).unwrap();
    assert!(!stale.exists(), "启动清扫必须删掉残留 ring 文件");
    assert_eq!(std::fs::metadata(&data_dir).unwrap().permissions().mode() & 0o777, 0o700);
    #[cfg(not(target_os = "macos"))]
    assert!(data_dir.join("CACHEDIR.TAG").exists(), "Linux 用 CACHEDIR.TAG 排除备份");
    #[cfg(target_os = "macos")]
    {
        let output = std::process::Command::new("xattr")
            .arg("-p")
            .arg("com.apple.metadata:com_apple_backup_excludeItem")
            .arg(&data_dir)
            .output()
            .unwrap();
        assert!(
            String::from_utf8_lossy(&output.stdout).contains("com.apple.backupd"),
            "macOS 目录必须带 Time Machine 排除属性"
        );
    }
    let client = PtydClient::connect(ptyd.socket_path()).unwrap();
    spawn(&client, "cat", &["cat"]);
    let path = data_dir.join(ring::file_name_for("cat"));
    assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
    assert!(client.remove("cat").is_err(), "运行中的 session 不能 remove");
    client.kill("cat").unwrap();
    wait_exit(&client, "cat");
    client.remove("cat").unwrap();
    assert!(!path.exists(), "session 结束即 unlink");
    assert!(Ptyd::start(PtydConfig::for_home(&home)).is_err(), "同一 home 不能起第二个 ptyd");
    finish(ptyd, home);
}

#[test]
fn closing_every_supervisor_connection_leaves_the_shell_alive() {
    // EOT 陷阱的直接测试：portable_pty 的 writer 在 Drop 时会写 EOT；这里 supervisor 的全部连接
    // （请求、输入、订阅）一起消失，cat 必须还活着。
    let (ptyd, client, home) = start("eot");
    let session = "cat";
    let pid = spawn(&client, session, &["cat"]);
    let mut input = client.input_channel().unwrap();
    let events = client.subscribe(session, 0).unwrap();
    input.write(session, "client", 1, b"hello\n").unwrap();
    // 回显 + cat 的输出
    assert!(collect_output(&events, 6, Duration::from_secs(10)).windows(5).any(|window| window == b"hello"));
    drop(input);
    drop(events);
    drop(client);
    std::thread::sleep(Duration::from_millis(400));
    let client = PtydClient::connect(ptyd.socket_path()).unwrap();
    let info = client.list().unwrap().into_iter().find(|info| info.session_id == session).unwrap();
    assert_eq!(info.exit_code, None, "supervisor 断开不能等于替 shell 按 Ctrl-D");
    // SAFETY: 只探测存活。
    assert_eq!(unsafe { libc::kill(pid, 0) }, 0, "cat 进程必须仍存活");
    // 新 supervisor 接上后照常读写。
    let events = client.subscribe(session, info.output_offset).unwrap();
    let mut input = client.input_channel().unwrap();
    let written = input.write(session, "client", 2, b"again\n").unwrap();
    assert_eq!(written.applied_through_seq, 2, "游标跨连接保留");
    assert!(collect_output(&events, 6, Duration::from_secs(10)).windows(5).any(|window| window == b"again"));
    client.kill(session).unwrap();
    wait_exit(&client, session);
    client.remove(session).unwrap();
    finish(ptyd, home);
}

#[test]
fn reduced_op_set_is_both_advertised_and_enforced() {
    let home = temp_home("ops");
    let config = PtydConfig::for_home(&home).with_ops(&["open", "spawn", "list", "subscribe", "read", "write", "resize", "kill", "remove", "status"]);
    let ptyd = Ptyd::start(config).unwrap();
    let client = PtydClient::connect(ptyd.socket_path()).unwrap();
    assert!(!client.supports("checkpoint"));
    assert!(matches!(client.checkpoint("x", 0, b""), Err(PtydError::Unsupported("checkpoint"))));
    assert!(matches!(client.blob("x"), Err(PtydError::Unsupported("blob"))));

    // 绕过客户端的能力门，直接发一条 checkpoint：服务端也必须回 unknown_op，行为与旧 ptyd 一致。
    let mut stream = UnixStream::connect(ptyd.socket_path()).unwrap();
    stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    let request = PtydRequestEnvelope {
        id: 5,
        request: PtydRequest::Checkpoint { session_id: "x".into(), offset: 0 },
    };
    stream.write_all(&encode_ptyd_record(&request, b"blob").unwrap()).unwrap();
    let mut parser = coflux_protocol::RecordParser::new();
    let mut messages: Vec<PtydMessage> = Vec::new();
    let mut buffer = [0u8; 4096];
    while messages.len() < 2 {
        let count = stream.read(&mut buffer).unwrap();
        assert!(count > 0);
        parser
            .push(&buffer[..count], |payload| {
                let (header, _) = split_ptyd_payload(payload).unwrap();
                messages.push(serde_json::from_slice(header).unwrap());
            })
            .unwrap();
    }
    assert!(matches!(&messages[0], PtydMessage::Hello { ops, .. } if !ops.iter().any(|op| op == "checkpoint")));
    assert!(matches!(&messages[1], PtydMessage::Error { id: 5, code, .. } if code == "unknown_op"));
    // 一个 v1 里根本不存在的 op 同样只是一条 unknown_op，不断连。
    stream
        .write_all(&encode_ptyd_record(&serde_json::json!({"id": 6, "op": "teleport"}), b"").unwrap())
        .unwrap();
    while messages.len() < 3 {
        let count = stream.read(&mut buffer).unwrap();
        assert!(count > 0);
        parser
            .push(&buffer[..count], |payload| {
                let (header, _) = split_ptyd_payload(payload).unwrap();
                messages.push(serde_json::from_slice(header).unwrap());
            })
            .unwrap();
    }
    assert!(matches!(&messages[2], PtydMessage::Error { id: 6, code, .. } if code == "unknown_op"));
    finish(ptyd, home);
}

#[test]
fn status_counts_live_sessions_and_shutdown_needs_the_instance_id() {
    let (ptyd, client, home) = start("status");
    spawn(&client, "one", &["cat"]);
    spawn(&client, "two", &["sh", "-c", "exit 0"]);
    wait_exit(&client, "two");
    let status = client.status().unwrap();
    assert_eq!(status.instance_id, ptyd.instance_id());
    assert_eq!(status.identity, "in-process");
    let one = status.sessions.iter().find(|session| session.session_id == "one").unwrap();
    let two = status.sessions.iter().find(|session| session.session_id == "two").unwrap();
    assert!(!one.exited);
    assert!(two.exited);
    client.shutdown().unwrap();
    ptyd.wait_for_shutdown();
    finish(ptyd, home);
}
