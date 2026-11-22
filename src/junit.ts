import path from "node:path";

export type TestStatus = "pass" | "fail" | "error" | "skipped";

export interface TestCase {
  id: string;
  status: TestStatus;
  message?: string;
}

interface Element {
  name: string;
  attrs: Record<string, string>;
  children: Element[];
  text: string;
}

const ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z]+);/g, (whole, ref: string) => {
    if (ref.startsWith("#x")) return safeCodePoint(Number.parseInt(ref.slice(2), 16)) ?? whole;
    if (ref.startsWith("#")) return safeCodePoint(Number.parseInt(ref.slice(1), 10)) ?? whole;
    return ENTITIES[ref] ?? whole;
  });
}

function safeCodePoint(n: number): string | undefined {
  return Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : undefined;
}

/**
 * A small XML reader, enough for JUnit reports: elements, attributes, text, CDATA.
 * Comments, processing instructions, and DOCTYPE are skipped.
 */
export function parseXml(xml: string): Element {
  const root: Element = { name: "#root", attrs: {}, children: [], text: "" };
  const stack: Element[] = [root];
  let i = 0;
  const top = (): Element => stack[stack.length - 1] as Element;
  const skipTo = (marker: string): void => {
    const end = xml.indexOf(marker, i);
    if (end < 0) throw new Error(`unterminated markup at offset ${i}`);
    i = end + marker.length;
  };
  while (i < xml.length) {
    const lt = xml.indexOf("<", i);
    if (lt < 0) {
      top().text += decode(xml.slice(i));
      break;
    }
    if (lt > i) top().text += decode(xml.slice(i, lt));
    i = lt;
    if (xml.startsWith("<!--", i)) {
      skipTo("-->");
    } else if (xml.startsWith("<![CDATA[", i)) {
      const end = xml.indexOf("]]>", i);
      if (end < 0) throw new Error("unterminated CDATA");
      top().text += xml.slice(i + 9, end);
      i = end + 3;
    } else if (xml.startsWith("<?", i)) {
      skipTo("?>");
    } else if (xml.startsWith("<!", i)) {
      skipTo(">");
    } else if (xml.startsWith("</", i)) {
      const end = xml.indexOf(">", i);
      if (end < 0) throw new Error("unterminated end tag");
      const name = xml.slice(i + 2, end).trim();
      i = end + 1;
      if (top().name !== name) throw new Error(`mismatched </${name}>, expected </${top().name}>`);
      stack.pop();
    } else {
      i++;
      const nameMatch = /^[^\s/>]+/.exec(xml.slice(i, i + 256));
      if (!nameMatch) throw new Error(`bad tag at offset ${i}`);
      const el: Element = { name: nameMatch[0], attrs: {}, children: [], text: "" };
      i += nameMatch[0].length;
      let selfClosing = false;
      for (;;) {
        while (i < xml.length && /\s/.test(xml[i] as string)) i++;
        if (i >= xml.length) throw new Error("unterminated start tag");
        if (xml.startsWith("/>", i)) {
          selfClosing = true;
          i += 2;
          break;
        }
        if (xml[i] === ">") {
          i++;
          break;
        }
        const eq = xml.indexOf("=", i);
        if (eq < 0) throw new Error("attribute without a value");
        const attrName = xml.slice(i, eq).trim();
        i = eq + 1;
        while (/\s/.test(xml[i] ?? "")) i++;
        const quote = xml[i];
        if (quote !== '"' && quote !== "'") throw new Error("unquoted attribute value");
        const close = xml.indexOf(quote, i + 1);
        if (close < 0) throw new Error("unterminated attribute value");
        el.attrs[attrName] = decode(xml.slice(i + 1, close));
        i = close + 1;
      }
      top().children.push(el);
      if (!selfClosing) stack.push(el);
    }
  }
  if (stack.length !== 1) throw new Error(`unclosed <${top().name}>`);
  return root;
}

/**
 * Test results from a JUnit XML report. Ids are stable across checkouts in different folders:
 * absolute `file` attributes are made relative to `root`.
 */
export function parseJUnit(xml: string, root: string): TestCase[] {
  const doc = parseXml(xml);
  const found: Array<{ el: Element; suites: string[] }> = [];
  const walk = (el: Element, suites: string[]): void => {
    for (const child of el.children) {
      if (child.name === "testcase") found.push({ el: child, suites });
      else if (child.name === "testsuite") walk(child, [...suites, child.attrs.name ?? ""]);
      else walk(child, suites);
    }
  };
  walk(doc, []);

  // When every test sits in the same outermost suite (pytest's "pytest", jest's "jest tests"), that name adds nothing.
  const first = found[0]?.suites[0];
  const dropOuter = first !== undefined && found.every((f) => f.suites.length > 0 && f.suites[0] === first);

  const seen = new Map<string, number>();
  return found.map(({ el, suites }) => {
    const file = el.attrs.file ? relativeTo(root, el.attrs.file) : undefined;
    const parts = [file, ...(dropOuter ? suites.slice(1) : suites), file ? undefined : el.attrs.classname, el.attrs.name ?? ""];
    let id = parts.filter((p): p is string => p !== undefined && p !== "").join("::");
    const n = (seen.get(id) ?? 0) + 1;
    seen.set(id, n);
    if (n > 1) id = `${id} #${n}`;

    let status: TestStatus = "pass";
    let message: string | undefined;
    for (const child of el.children) {
      if (child.name === "failure" || child.name === "error") {
        status = child.name === "failure" ? "fail" : "error";
        message = (child.attrs.message ?? child.text).trim().slice(0, 500);
        break;
      }
      if (child.name === "skipped") status = "skipped";
    }
    if (status === "pass" && el.attrs.failure !== undefined) status = "fail";
    return message === undefined ? { id, status } : { id, status, message };
  });
}

function relativeTo(root: string, file: string): string {
  const isAbs = path.isAbsolute(file) || /^[A-Za-z]:[\\/]/.test(file);
  let rel = file;
  if (isAbs) {
    rel = path.relative(root, file);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      // Different spelling of the same folder (8.3 names, case). Fall back to the folder's unique name.
      const norm = file.replace(/\\/g, "/");
      const marker = `/${root.split(/[\\/]/).filter(Boolean).pop() ?? ""}/`;
      const at = norm.toLowerCase().lastIndexOf(marker.toLowerCase());
      rel = at >= 0 ? norm.slice(at + marker.length) : norm;
    }
  }
  return rel.replace(/\\/g, "/");
}
