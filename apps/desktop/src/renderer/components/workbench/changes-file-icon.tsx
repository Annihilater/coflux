import { fileIconName, folderIconName } from "@/components/workbench/changes-file-icons";
import { cn } from "@/lib/utils";

/*
 * File-type and folder icons of the changes view (plan 20261001-changes-review-polish), from the
 * vendored Catppuccin set. They are inlined, not <img>, because their colours are
 * `var(--vscode-ctp-*)` variables defined in index.css. Loaded eagerly (≈ 85 KB gzip for the whole
 * set) so switching files never shows a missing icon.
 */

const RAW_ICONS = import.meta.glob<string>("../../assets/file-icons/icons/*.svg", {
  query: "?raw",
  import: "default",
  eager: true,
});

/** Icon name → markup. Ids are scoped per icon so two icons on one page cannot share a clip path. */
const ICONS = new Map<string, string>(
  Object.entries(RAW_ICONS).map(([file, svg]) => {
    const name = file.slice(file.lastIndexOf("/") + 1, -".svg".length);
    const scoped = svg
      .replace(/\bid="([^"]+)"/g, `id="fi-${name}-$1"`)
      .replace(/url\(#([^)]+)\)/g, `url(#fi-${name}-$1)`)
      .replace(/href="#([^"]+)"/g, `href="#fi-${name}-$1"`);
    return [name, scoped];
  }),
);

function Svg({ name, className }: { name: string; className?: string }) {
  const markup = ICONS.get(name) ?? ICONS.get("_file") ?? "";
  return (
    <span
      aria-hidden
      className={cn("inline-flex size-4 shrink-0 items-center justify-center [&>svg]:size-4", className)}
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  );
}

export function FileTypeIcon({ path, className }: { path: string; className?: string }) {
  return <Svg name={fileIconName(path)} className={className} />;
}

export function FolderIcon({ name, open, className }: { name: string; open: boolean; className?: string }) {
  return <Svg name={folderIconName(name, open)} className={className} />;
}
