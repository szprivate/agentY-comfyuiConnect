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


class DroppedNodesKeepTheirTitles(unittest.TestCase):
    """The panel must not retitle a node it puts on the canvas.

    It used to set `node.title = "agentY · " + role`, and a role is a whole
    sentence out of a hook's directive. Litegraph sizes a node to fit its title,
    so every dropped render arrived as a wide bar that shoved the rest of the
    graph sideways — for information that already travels beside the file, in the
    .agenty.json that canvas_hooks._recorded_role reads.

    Checked structurally because there is no JavaScript runtime here, and because
    the regression is a one-line edit that looks entirely reasonable in review.
    """

    def _inject_node(self):
        src = (WEB / "agent_chat.js").read_text(encoding="utf-8")
        start = src.find("\n  injectNode(ev) {")
        self.assertGreater(start, 0, "injectNode() is gone or was renamed")
        # To the start of the next method at the same indent.
        end = src.find("\n  _attachRefNote(", start)
        self.assertGreater(end, start, "could not find the end of injectNode()")
        return strip_literals(src[start:end])

    def test_it_assigns_no_title(self):
        body = self._inject_node()
        self.assertNotIn(".title =", body,
                         "injectNode() is setting a node title again")

    def test_the_role_still_reaches_the_ref_note(self):
        """Removing the title must not have removed the role's other carrier."""
        body = self._inject_node()
        self.assertIn("_attachRefNote", body)

    def test_the_tag_note_has_a_fixed_title(self):
        """The one node the agent adds that IS titled says the same thing every
        time — like every other agentY node — instead of repeating the role that
        is already in the widget below it."""
        src = (WEB / "agent_chat.js").read_text(encoding="utf-8")
        self.assertIn('note.title = "agentY tag";', src)
        self.assertNotIn('"agentY tag · "', src)


class AFreshTabCanStillAuthenticate(unittest.TestCase):
    """A tab is ALWAYS older than the host's session token.

    The host mints a new one every start, and the page reads it once, at load —
    which is before the host was started, or before its last restart, or both. So
    a panel with no token, or with a previous host's token, is the ordinary state
    of a freshly opened ComfyUI tab, not an error case.

    The first version returned early when the token was empty and sent the request
    bare. That skipped the retry with it: the panel 403'd every request for the
    life of the tab, showed nothing on screen, and could only be fixed by a reload
    it never asked for. These pin the shape that cannot do that.
    """

    def source(self):
        return strip_literals((WEB / "agent_backend.js").read_text(encoding="utf-8"))

    def test_an_empty_token_does_not_skip_the_request_handling(self):
        self.assertNotIn("if (!sessionToken) return real", self.source(),
                         "a missing token must not bypass the 403 retry below it")

    def test_a_missing_token_is_fetched_rather_than_given_up_on(self):
        self.assertIn("refreshToken(", self.source())

    def test_a_refusal_still_reaches_the_screen(self):
        """The console is where this went for a week. It has to reach the UI."""
        self.assertIn("announceRefusal", self.source())
        self.assertIn("showNotice", self.source())

    def test_the_refresh_is_rate_limited(self):
        """Both callers are on the hot path. An extension too old to return a
        token would otherwise put a host_info round trip in front of every
        request the panel makes."""
        self.assertIn("REFRESH_MS", self.source())


if __name__ == "__main__":
    unittest.main()
