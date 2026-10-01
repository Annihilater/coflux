import {
  DEFAULT_FILE_ICON,
  DEFAULT_FOLDER_ICON,
  DEFAULT_FOLDER_OPEN_ICON,
  FILE_EXTENSIONS,
  FILE_NAMES,
  FOLDER_NAMES,
  FOLDER_NAMES_EXPANDED,
} from "../../assets/file-icons/mapping";

/**
 * File and folder icon resolution for the changes tree (plan 20261001-changes-review-polish),
 * the way VS Code resolves a file icon theme: the lower-cased full file name first, then the
 * longest compound extension down to the shortest (`d.ts` before `ts`), then the default. Folders
 * match by lower-cased name, with separate tables for open and closed.
 *
 * The tables come from the vendored Catppuccin set (scripts/vendor-file-icons.mjs); the local
 * overrides below fill names the set does not map.
 */

const LOCAL_FILE_NAMES: Readonly<Record<string, string>> = {
  "agents.md": "readme",
  "claude.md": "readme",
};

const LOCAL_FOLDER_NAMES: Readonly<Record<string, string>> = {
  wiki: "folder_docs",
};

function own(table: Readonly<Record<string, string>>, key: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

/** The icon name for a file path (only its last segment matters). */
export function fileIconName(path: string): string {
  const name = (path.split("/").pop() ?? path).toLowerCase();
  const byName = own(LOCAL_FILE_NAMES, name) ?? own(FILE_NAMES, name);
  if (byName) return byName;
  // "foo.test.ts" tries "test.ts", then "ts". Like VS Code, a dotfile's name counts as an
  // extension too: ".eslintrc.json" tries "eslintrc.json", then "json".
  for (let at = name.indexOf("."); at >= 0; at = name.indexOf(".", at + 1)) {
    const extension = name.slice(at + 1);
    if (!extension) break;
    const byExtension = own(FILE_EXTENSIONS, extension);
    if (byExtension) return byExtension;
  }
  return DEFAULT_FILE_ICON;
}

/** The icon name for a folder. A compact row (`renderer/components`) uses its last folder. */
export function folderIconName(label: string, open: boolean): string {
  const name = (label.split("/").pop() ?? label).toLowerCase();
  const local = own(LOCAL_FOLDER_NAMES, name);
  if (local) return open ? `${local}_open` : local;
  const icon = own(open ? FOLDER_NAMES_EXPANDED : FOLDER_NAMES, name);
  return icon ?? (open ? DEFAULT_FOLDER_OPEN_ICON : DEFAULT_FOLDER_ICON);
}
