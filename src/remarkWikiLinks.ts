import { splitLink } from "./model";

// Transform parsed text nodes, never raw Markdown. Code, HTML, math, link destinations,
// and source offsets therefore stay intact even with aliases containing punctuation.
export function remarkWikiLinks() {
  return (tree: any) => {
    function visit(parent: any) {
      if (
        !parent.children ||
        [
          "link",
          "linkReference",
          "code",
          "inlineCode",
          "html",
          "math",
          "inlineMath",
        ].includes(parent.type)
      )
        return;
      const children: any[] = [];
      for (const child of parent.children) {
        if (child.type !== "text") {
          visit(child);
          children.push(child);
          continue;
        }
        const value: string = child.value;
        let end = 0;
        for (const match of value.matchAll(/!?\[\[([^\]\n]+)\]\]/g)) {
          const start = match.index!;
          if (start > end)
            children.push({ type: "text", value: value.slice(end, start) });
          const [target, ...aliases] = match[1].split("|");
          const label = aliases.join("|") || target;
          const embed = match[0].startsWith("!");
          const image =
            embed &&
            /\.(?:png|jpe?g|gif|webp|svg|avif|bmp)$/i.test(
              splitLink(target).target,
            );
          children.push(
            image
              ? {
                  type: "image",
                  url: "lithos-asset:" + encodeURIComponent(target),
                  alt: target,
                  title: null,
                }
              : {
                  type: "link",
                  url: "lithos-link:" + encodeURIComponent(target),
                  title: embed ? "임베드된 노트 열기" : null,
                  children: [
                    { type: "text", value: (embed ? "↗ " : "") + label },
                  ],
                },
          );
          end = start + match[0].length;
        }
        if (!end) children.push(child);
        else if (end < value.length)
          children.push({ type: "text", value: value.slice(end) });
      }
      parent.children = children;
    }
    visit(tree);
  };
}
