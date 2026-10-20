import { Router } from "express";

const MAX_TEXT = 90_000; // stays under the 100kb JSON body limit in app.ts

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * POST /api/v1/tools/find-replace
 * body: { text, find, replace?, caseSensitive?, wholeWord? }
 * Plain-text matching only (no user regex), so it can't be used for ReDoS.
 * Pure text transform: nothing is stored or written to disk.
 */
const router = Router();

router.post("/tools/find-replace", (req, res) => {
  const { text, find, replace = "", caseSensitive = false, wholeWord = false } = req.body ?? {};

  if (typeof text !== "string" || typeof find !== "string" || typeof replace !== "string") {
    return res.status(400).json({ error: { code: "bad_request", message: "text, find and replace must be strings" } });
  }
  if (find === "") {
    return res.status(400).json({ error: { code: "bad_request", message: "find cannot be empty" } });
  }
  if (text.length > MAX_TEXT || find.length > 500 || replace.length > 5000) {
    return res.status(413).json({ error: { code: "too_large", message: "Text is too large" } });
  }

  const body = wholeWord ? `\\b${escapeRe(find)}\\b` : escapeRe(find);
  const re = new RegExp(body, caseSensitive ? "g" : "gi");

  let count = 0;
  const result = text.replace(re, () => {
    count += 1;
    return replace; // function form: "$&" etc. in the replacement are treated literally
  });

  return res.json({ result, count });
});

export default router;
