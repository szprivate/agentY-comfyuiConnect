"""The panel's JavaScript, checked without a JavaScript engine.

There is no node, deno or bundler in a ComfyUI install, and none is going to be
added just to lint a sidebar — so nothing has ever read this code except a
browser, at the moment a user opens the tab. That is a bad place to find out.

What this catches is one specific, expensive mistake: a module-level constant that
was renamed or turned into a function, with one reference left behind. JavaScript
does not complain until the line runs, and the line that ran here was in the panel
constructor, so the whole sidebar died with `ReferenceError: OFFLINE_MSG is not
defined` and rendered nothing at all. It shipped in 097c941, which changed
`const OFFLINE_MSG` into `function offlineMsg()` for the Windows/macOS wording,
updated four call sites, and missed the fifth. Every platform was affected; it
survived because a blank panel looks like a connection problem, and there was a
real connection problem sitting in front of it.

This is a heuristic, not a parser, and it is deliberately narrow: SCREAMING_CASE
names only, which is what module constants are called throughout web/. It is
verified both ways in the tests below - it flags the real regression and stays
silent on the tree as it stands - because a check that cries wolf gets switched
off and then catches nothing.
"""
import pathlib
import re
import unittest

WEB = pathlib.Path(__file__).resolve().parent.parent / "web"

# Words after which a '/' begins a regex literal rather than a division.
KEYWORDS = {"return", "typeof", "instanceof", "in", "of", "new", "delete", "void",
            "case", "do", "else", "yield", "await", "throw", "if", "while", "for",
            "switch", "and", "or"}

# Referenced but never declared anywhere, because the browser supplies them.
BROWSER_GLOBALS = {"JSON", "NaN", "URL", "DOM", "HTML", "API", "UI", "OK", "GET",
                   "POST", "DELETE", "PUT", "SSE", "HTTP", "HTTPS", "CSS", "SVG",
                   "XHR", "UTF"}

DECLARED = re.compile(
    r'\b(?:const|let|var|function|class|static)\s+([A-Z][A-Z0-9_]{2,})\b')
# Not after a dot (a property, not a free name) and not before a colon (a key).
REFERENCED = re.compile(r'(?<![.\w$])([A-Z][A-Z0-9_]{2,})\b(?!\s*:)')
IMPORTED = re.compile(r'\bimport\s*\{([^}]*)\}')


def strip_literals(src: str) -> str:
    """Blank out comments, strings and regex literals, leaving code.

    Regex-vs-division is decided the way hand-written JS lexers decide it: a '/'
    opens a regex unless the previous significant token could END an expression.
    Getting this wrong is not cosmetic - a regex holding an apostrophe would
    desynchronise the scan and every following string would be read as code.
    """
    out, i, n, prev, word = [], 0, len(src), "", ""
    while i < n:
        c = src[i]
        nxt = src[i + 1] if i + 1 < n else ""
        if c == "/" and nxt == "/":
            j = src.find("\n", i)
            i = n if j < 0 else j
            continue
        if c == "/" and nxt == "*":
            j = src.find("*/", i + 2)
            i = n if j < 0 else j + 2
            continue
        if c in "\"'`":
            quote = c
            i += 1
            while i < n and src[i] != quote:
                i += 2 if src[i] == "\\" else 1
            i += 1
            out.append(" ")
            prev, word = "x", ""
            continue
        ends_expression = prev in (")", "]", "}") or (prev == "x" and word not in KEYWORDS)
        if c == "/" and not ends_expression:
            i += 1
            in_class = False
            while i < n:
                if src[i] == "\\":
                    i += 2
                    continue
                if src[i] == "[":
                    in_class = True
                elif src[i] == "]":
                    in_class = False
                elif src[i] == "/" and not in_class:
                    break
                elif src[i] == "\n":
                    break
                i += 1
            i += 1
            while i < n and src[i].isalpha():   # flags: g, i, m, ...
                i += 1
            out.append(" ")
            prev, word = "x", ""
            continue
        out.append(c)
        if c.isalnum() or c in "_$":
            word = (word + c) if prev == "x" else c
            prev = "x"
        elif not c.isspace():
            prev, word = c, ""
        i += 1
    return "".join(out)


def undefined_constants(source: str) -> list[str]:
    """SCREAMING_CASE names *used* in *source* that nothing there defines."""
    code = strip_literals(source)
    declared = set(DECLARED.findall(code))
    for group in IMPORTED.findall(code):
        declared |= {part.strip().split(" as ")[-1].strip()
                     for part in group.split(",") if part.strip()}
    return sorted(set(REFERENCED.findall(code)) - declared - BROWSER_GLOBALS)


class NoUndefinedConstants(unittest.TestCase):

    def test_every_panel_file_is_clean(self):
        for path in sorted(WEB.glob("*.js")):
            with self.subTest(file=path.name):
                self.assertEqual(undefined_constants(path.read_text(encoding="utf-8")), [],
                                 f"{path.name} references a constant nothing declares")


class TheCheckActuallyChecks(unittest.TestCase):
    """A guard nobody has seen fail is a guard nobody should trust."""

    def test_it_catches_the_regression_it_exists_for(self):
        broken = 'function offlineMsg() { return "x"; }\nel({ innerHTML: mdToHtml(OFFLINE_MSG) });'
        self.assertEqual(undefined_constants(broken), ["OFFLINE_MSG"])

    def test_the_fixed_form_is_accepted(self):
        fixed = 'function offlineMsg() { return "x"; }\nel({ innerHTML: mdToHtml(offlineMsg()) });'
        self.assertEqual(undefined_constants(fixed), [])

    def test_a_declared_constant_is_not_flagged(self):
        self.assertEqual(undefined_constants('const DOCS_URL = "u";\nopen(DOCS_URL);'), [])

    def test_an_imported_name_is_not_flagged(self):
        self.assertEqual(
            undefined_constants('import { BACKEND_KEY } from "./x.js";\nuse(BACKEND_KEY);'), [])

    def test_a_static_class_field_is_not_flagged(self):
        """The form that made the first draft of this check cry wolf."""
        self.assertEqual(
            undefined_constants('class A { static ALWAYS = [1]; }\nA.ALWAYS.includes(2);'), [])

    def test_words_inside_a_regex_are_not_references(self):
        """`return /KEY|TOKEN/i.test(k)` - the other false positive. A regex after
        `return` is a regex, not a division by an identifier."""
        self.assertEqual(
            undefined_constants('function f(k) { return /KEY|TOKEN|SECRET/i.test(k); }'), [])

    def test_words_inside_strings_are_not_references(self):
        self.assertEqual(undefined_constants('if (t.tagName !== "TEXTAREA") return 1;'), [])

    def test_a_property_access_is_not_a_free_name(self):
        self.assertEqual(undefined_constants('x.SOME_PROP = 1;\nconsole.log(y.OTHER_ONE);'), [])

    def test_a_regex_holding_a_quote_does_not_desynchronise_the_scan(self):
        """If this broke, every string after it would be scanned as code."""
        src = 'const RE = /['"'"'"]/g;\nconst s = "NOT_A_NAME";\nuse(RE, s);'
        self.assertEqual(undefined_constants(src), [])


if __name__ == "__main__":
    unittest.main()
