/** Root-relative links work even when a note is in a nested folder. */
export function attachmentMarkdown(path: string): string {
  const name = path.split("/").pop() || path;
  const label = name.replace(/[\r\n]/g, " ").replace(/[\\[\]*_`|]/g, "\\$&");
  const url = "/" + path.split("/").map(encodeURIComponent).join("/");
  return /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i.test(path)
    ? `![${label}](<${url}>)`
    : `[${label}](<${url}?download=1>)`;
}
