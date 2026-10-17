import { useEffect, useId, useState } from "react";

const MAX_SOURCE_LENGTH = 20_000;
let engine: Promise<typeof import("mermaid")["default"]> | undefined;

function loadMermaid() {
  engine ??= import("mermaid")
    .then(({ default: mermaid }) => {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        suppressErrorRendering: true,
        maxTextSize: MAX_SOURCE_LENGTH,
        maxEdges: 500,
        htmlLabels: false,
        theme: "default",
        fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
        // Diagram directives must not relax the reader's safety settings.
        secure: [
          "secure", "securityLevel", "startOnLoad", "maxTextSize", "maxEdges",
          "suppressErrorRendering", "htmlLabels", "themeCSS", "themeVariables",
          "dompurifyConfig", "fontFamily", "altFontFamily",
        ],
      });
      return mermaid;
    })
    .catch((error) => {
      engine = undefined;
      throw error;
    });
  return engine;
}

export function MermaidDiagram({ source }: { source: string }) {
  const id = "lithos-mermaid-" + useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const [svg, setSvg] = useState("");
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setSvg("");
    setError("");
    if (!source.trim() || source.length > MAX_SOURCE_LENGTH) {
      setError(source.trim()
        ? "다이어그램이 너무 큽니다. 원문을 20,000자 이하로 줄여 주세요."
        : "다이어그램 원문이 비어 있습니다.");
      return;
    }
    async function render() {
      // A separate offscreen container avoids mutating React's DOM while Mermaid
      // measures labels. It is always removed, including syntax-error cases.
      let container: HTMLDivElement | undefined;
      try {
        const mermaid = await loadMermaid();
        if (cancelled) return;
        await document.fonts.ready;
        if (cancelled) return;
        container = document.createElement("div");
        container.className = "mermaid-measure";
        container.setAttribute("aria-hidden", "true");
        document.body.append(container);
        const result = await mermaid.render(id, source, container);
        if (!cancelled) setSvg(result.svg);
        // Deliberately do not install Mermaid's optional click callbacks.
      } catch {
        if (!cancelled)
          setError("다이어그램을 표시하지 못했습니다. 아래 원문의 Mermaid 문법을 확인해 주세요.");
      } finally {
        container?.remove();
      }
    }
    void render();
    return () => { cancelled = true; };
  }, [id, source]);

  return (
    <figure className="mermaid-diagram" aria-label="Mermaid 다이어그램">
      <div className="mermaid-toolbar">
        <span>Mermaid</span>
        {svg && (
          <button type="button" aria-pressed={expanded} onClick={() => setExpanded(!expanded)}>
            {expanded ? "화면에 맞추기" : "크게 보기"}
          </button>
        )}
      </div>
      {svg ? (
        <div
          className={`mermaid-viewport${expanded ? " is-expanded" : ""}`}
          role="region"
          aria-label="다이어그램 그림"
          tabIndex={0}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      ) : (
        <p className="mermaid-message" role="status">
          {error || "다이어그램을 그리는 중…"}
        </p>
      )}
      <details className="mermaid-source" open={error ? true : undefined}>
        <summary>Mermaid 원문 보기</summary>
        <pre><code className="language-mermaid">{source}</code></pre>
      </details>
    </figure>
  );
}
