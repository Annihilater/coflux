import type { ReactNode } from "react";
import { Button } from "@astryxdesign/core/Button";
import { HStack, LayoutFooter } from "@astryxdesign/core/Layout";

/** 底栏按钮里的键位提示（Cursor 式）：按钮内、紧跟文字的弱化小字，不是键帽方块。
 * 纯装饰——真正的键位行为由 Dialog 的 Esc 处理、表单的 submit 或动作按钮的焦点承担——读屏忽略。 */
export function KeyHint({ label }: { label: string }) {
  return (
    <span aria-hidden className="text-xs opacity-60">
      {label}
    </span>
  );
}

export type FooterAction = {
  label: string;
  onClick: () => void;
  /** 默认 primary；确认框的删除类动作用 destructive。 */
  variant?: "primary" | "destructive";
  isDisabled?: boolean;
  /** 打开即聚焦到这个按钮，原生 Enter/Space 即触发（Dialog 只认第一个 data-autofocus）。
   * 表单弹窗不要开：焦点必须留在输入框，Enter 走 form submit。 */
  hasAutofocus?: boolean;
};

/** 弹窗共用的底栏：分割线、右对齐、sm 尺寸；ghost「取消」带 Esc，动作按钮带 ↵。
 * `startContent` 留给靠左的破坏性动作（比如「删除」），它不该和确认按钮挨在一起。 */
export function DialogFooterActions(props: {
  onCancel?: () => void;
  action: FooterAction;
  startContent?: ReactNode;
}) {
  const { action } = props;
  return (
    <LayoutFooter hasDivider>
      <HStack gap={2} vAlign="center" hAlign={props.startContent ? "between" : "end"}>
        {props.startContent ?? null}
        <HStack gap={2} vAlign="center" hAlign="end">
          {props.onCancel ? (
            <Button label="取消" variant="ghost" size="sm" endContent={<KeyHint label="Esc" />} onClick={props.onCancel} />
          ) : null}
          <Button
            label={action.label}
            variant={action.variant ?? "primary"}
            size="sm"
            endContent={<KeyHint label="↵" />}
            onClick={action.onClick}
            isDisabled={action.isDisabled}
            data-autofocus={action.hasAutofocus ? "true" : undefined}
          />
        </HStack>
      </HStack>
    </LayoutFooter>
  );
}
