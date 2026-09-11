import type { Page } from "playwright-core";

export interface DomFieldRecord {
  cloakId: string;
  tag: string;
  inputType: string | null;
  label: string | null;
  placeholder: string | null;
  nearbyText: string | null;
  visible: boolean;
}

export interface ExtractTextDomResult {
  markdown: string;
  fields: DomFieldRecord[];
}

export interface FormSchemaField {
  id: string | null;
  name: string | null;
  type: string;
  label: string | null;
  tag: "input" | "select" | "textarea";
  hidden: boolean;
  visible: boolean;
  /** name/id 含 token、hash、signature 等字眼，通常由 JS 动态写入，不应放入常规填表模板 */
  likelyDynamic: boolean;
}

export interface PageFormSchema {
  url: string;
  fields: FormSchemaField[];
}

const EXTRACT_FORM_SCHEMA_SCRIPT = () => {
  function cleanText(value: string | null | undefined): string | null {
    if (!value) {
      return null;
    }
    const normalized = value.replace(/\s+/g, " ").trim();
    return normalized.length > 0 ? normalized : null;
  }

  function resolveLabel(element: HTMLElement): string | null {
    const chunks: string[] = [];

    if (
      element instanceof HTMLInputElement ||
      element instanceof HTMLSelectElement ||
      element instanceof HTMLTextAreaElement
    ) {
      const labels = element.labels;
      if (labels) {
        for (const label of Array.from(labels)) {
          const text = cleanText(label.textContent);
          if (text) {
            chunks.push(text);
          }
        }
      }
    }

    const elementId = element.id.trim();
    if (elementId) {
      const linkedLabel = document.querySelector(`label[for="${CSS.escape(elementId)}"]`);
      const linkedText = cleanText(linkedLabel?.textContent ?? null);
      if (linkedText) {
        chunks.push(linkedText);
      }
    }

    const ariaLabel = cleanText(element.getAttribute("aria-label"));
    if (ariaLabel) {
      chunks.push(ariaLabel);
    }

    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy) {
      for (const id of labelledBy.split(/\s+/)) {
        const node = document.getElementById(id);
        const text = cleanText(node?.textContent ?? null);
        if (text) {
          chunks.push(text);
        }
      }
    }

    const parentLabel = element.closest("label");
    if (parentLabel) {
      const text = cleanText(parentLabel.textContent);
      if (text) {
        chunks.push(text);
      }
    }

    const deduped = Array.from(new Set(chunks));
    return deduped.length > 0 ? deduped.join(" | ") : null;
  }

  function isVisible(element: HTMLElement): boolean {
    if (!(element instanceof HTMLElement)) {
      return false;
    }
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
      return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function isLikelyDynamicField(id: string | null, name: string | null): boolean {
    const combined = `${id ?? ""} ${name ?? ""}`.toLowerCase();
    return /(?:^|[_-])(token|hash|signature|nonce|captcha|csrf|authenticity)(?:$|[_-])/.test(
      combined,
    );
  }

  const results: Array<{
    id: string | null;
    name: string | null;
    type: string;
    label: string | null;
    tag: "input" | "select" | "textarea";
    hidden: boolean;
    visible: boolean;
    likelyDynamic: boolean;
  }> = [];

  const elements = Array.from(document.querySelectorAll("input, select, textarea"));

  for (const element of elements) {
    const tag = element.tagName.toLowerCase();
    if (tag !== "input" && tag !== "select" && tag !== "textarea") {
      continue;
    }

    let type: string;
    if (element instanceof HTMLInputElement) {
      type = element.type || "text";
    } else if (element instanceof HTMLSelectElement) {
      type = element.multiple ? "select-multiple" : "select-one";
    } else {
      type = "textarea";
    }

    const htmlElement = element as HTMLElement;
    const id = cleanText(element.id) ?? null;
    const name = cleanText(element.getAttribute("name")) ?? null;
    const hidden = type === "hidden" || element.getAttribute("type") === "hidden";
    const visible = isVisible(htmlElement);

    results.push({
      id,
      name,
      type,
      label: resolveLabel(htmlElement),
      tag,
      hidden,
      visible,
      likelyDynamic: isLikelyDynamicField(id, name),
    });
  }

  return results;
};

export async function extractPageFormSchema(page: Page): Promise<PageFormSchema> {
  const fields: FormSchemaField[] = [];

  for (const frame of page.frames()) {
    const frameFields = await frame.evaluate(EXTRACT_FORM_SCHEMA_SCRIPT);
    fields.push(...frameFields);
  }

  return {
    url: page.url(),
    fields,
  };
}

const COLLECT_AND_TAG_SCRIPT = () => {
  const TAGS = new Set(["INPUT", "SELECT", "BUTTON"]);
  const results: Array<{
    cloakId: string;
    tag: string;
    inputType: string | null;
    label: string | null;
    placeholder: string | null;
    nearbyText: string | null;
    visible: boolean;
  }> = [];

  function isVisible(element: Element): boolean {
    if (!(element instanceof HTMLElement)) {
      return false;
    }
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
      return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function cleanText(value: string | null | undefined): string | null {
    if (!value) {
      return null;
    }
    const normalized = value.replace(/\s+/g, " ").trim();
    return normalized.length > 0 ? normalized : null;
  }

  function nearbyTextFor(element: HTMLElement): string | null {
    const chunks: string[] = [];

    const labels = (element as HTMLInputElement | HTMLSelectElement).labels;
    if (labels) {
      for (const label of Array.from(labels)) {
        const text = cleanText(label.textContent);
        if (text) {
          chunks.push(text);
        }
      }
    }

    const ariaLabel = cleanText(element.getAttribute("aria-label"));
    if (ariaLabel) {
      chunks.push(ariaLabel);
    }

    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy) {
      for (const id of labelledBy.split(/\s+/)) {
        const node = document.getElementById(id);
        const text = cleanText(node?.textContent ?? null);
        if (text) {
          chunks.push(text);
        }
      }
    }

    const placeholder = cleanText(element.getAttribute("placeholder"));
    if (placeholder) {
      chunks.push(placeholder);
    }

    let previous = element.previousElementSibling;
    for (let step = 0; step < 3 && previous; step += 1) {
      const text = cleanText(previous.textContent);
      if (text && text.length <= 120) {
        chunks.push(text);
      }
      previous = previous.previousElementSibling;
    }

    const parentLabel = element.closest("label");
    if (parentLabel) {
      const text = cleanText(parentLabel.textContent);
      if (text) {
        chunks.push(text);
      }
    }

    const deduped = Array.from(new Set(chunks));
    return deduped.length > 0 ? deduped.join(" | ") : null;
  }

  let nextId = 1;
  const elements = Array.from(document.querySelectorAll("input, select, button"));

  for (const element of elements) {
    if (!TAGS.has(element.tagName)) {
      continue;
    }

    const htmlElement = element as HTMLElement;
    const visible = isVisible(htmlElement);
    if (!visible) {
      continue;
    }

    const cloakId = String(nextId);
    nextId += 1;
    htmlElement.setAttribute("data-cloak-id", cloakId);

    const tag = element.tagName.toLowerCase();
    const inputType =
      element instanceof HTMLInputElement ? element.type || "text" : tag === "button" ? "button" : tag;

    const label = nearbyTextFor(htmlElement);
    const placeholder = cleanText(element.getAttribute("placeholder"));
    const nearbyText =
      tag === "button"
        ? cleanText(htmlElement.innerText || htmlElement.textContent)
        : label;

    results.push({
      cloakId,
      tag,
      inputType,
      label,
      placeholder,
      nearbyText,
      visible,
    });
  }

  return results;
};

function toMarkdown(fields: DomFieldRecord[]): string {
  const lines = ["# Cloak Form Fields", ""];

  for (const field of fields) {
    const parts = [
      `- **${field.cloakId}** \`${field.tag}${field.inputType ? `[${field.inputType}]` : ""}\``,
    ];
    if (field.label) {
      parts.push(`label="${field.label}"`);
    }
    if (field.placeholder) {
      parts.push(`placeholder="${field.placeholder}"`);
    }
    if (field.nearbyText && field.nearbyText !== field.label) {
      parts.push(`nearby="${field.nearbyText}"`);
    }
    lines.push(parts.join(" "));
  }

  return lines.join("\n");
}

export async function extractTextDOM(page: Page): Promise<ExtractTextDomResult> {
  const fields: DomFieldRecord[] = [];

  for (const frame of page.frames()) {
    const frameFields = await frame.evaluate(COLLECT_AND_TAG_SCRIPT);
    fields.push(...frameFields);
  }

  return {
    markdown: toMarkdown(fields),
    fields,
  };
}

const DRAW_MARKERS_SCRIPT = () => {
  const STYLE_ID = "cloak-vision-marker-style";
  const ROOT_ID = "cloak-vision-marker-root";

  const existingStyle = document.getElementById(STYLE_ID);
  if (existingStyle) {
    existingStyle.remove();
  }
  const existingRoot = document.getElementById(ROOT_ID);
  if (existingRoot) {
    existingRoot.remove();
  }

  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    #${ROOT_ID} {
      position: absolute;
      left: 0;
      top: 0;
      width: 0;
      height: 0;
      z-index: 2147483646;
      pointer-events: none;
    }
    .cloak-vision-badge {
      position: absolute;
      min-width: 22px;
      height: 22px;
      padding: 0 6px;
      border-radius: 11px;
      background: rgba(220, 38, 38, 0.72);
      color: #fff;
      font: 700 12px/22px Arial, sans-serif;
      text-align: center;
      box-shadow: 0 0 0 1px rgba(255,255,255,0.85);
      pointer-events: none;
      transform: translate(-20%, -20%);
    }
  `;
  document.head.appendChild(style);

  const root = document.createElement("div");
  root.id = ROOT_ID;
  document.body.appendChild(root);

  const scrollX = window.scrollX;
  const scrollY = window.scrollY;
  const elements = Array.from(
    document.querySelectorAll("input[data-cloak-id], select[data-cloak-id], button[data-cloak-id]"),
  );

  let markerCount = 0;
  for (const element of elements) {
    const cloakId = element.getAttribute("data-cloak-id");
    if (!cloakId) {
      continue;
    }
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      continue;
    }

    const badge = document.createElement("div");
    badge.className = "cloak-vision-badge";
    badge.textContent = cloakId;
    badge.style.left = `${rect.left + scrollX}px`;
    badge.style.top = `${rect.top + scrollY}px`;
    root.appendChild(badge);
    markerCount += 1;
  }

  return markerCount;
};

const REMOVE_MARKERS_SCRIPT = () => {
  document.getElementById("cloak-vision-marker-style")?.remove();
  document.getElementById("cloak-vision-marker-root")?.remove();
};

export interface VisionMarkerResult {
  screenshotBase64: string;
  markerCount: number;
}

export async function drawVisionMarkers(page: Page): Promise<VisionMarkerResult> {
  let markerCount = 0;

  for (const frame of page.frames()) {
    markerCount += await frame.evaluate(DRAW_MARKERS_SCRIPT);
  }

  const screenshot = await page.screenshot({
    type: "png",
    fullPage: true,
  });

  for (const frame of page.frames()) {
    await frame.evaluate(REMOVE_MARKERS_SCRIPT);
  }

  return {
    screenshotBase64: screenshot.toString("base64"),
    markerCount,
  };
}

export async function removeVisionMarkers(page: Page): Promise<void> {
  for (const frame of page.frames()) {
    await frame.evaluate(REMOVE_MARKERS_SCRIPT);
  }
}
