import { test } from "node:test";
import assert from "node:assert/strict";
import { markdownToHtml, renderNewsletterEmail } from "../src/lib/newsletter/email-render.mjs";

test("headings, paragraphs, bold, italic and lists", () => {
  const html = markdownToHtml("# Big\n\nSome **bold** and *italic* text.\n\n- one\n- two\n\n1. first\n2. second");
  assert.match(html, /<h1 [^>]*>Big<\/h1>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<em>italic<\/em>/);
  assert.match(html, /<ul [^>]*><li [^>]*>one<\/li><li [^>]*>two<\/li><\/ul>/);
  assert.match(html, /<ol [^>]*><li [^>]*>first<\/li><li [^>]*>second<\/li><\/ol>/);
});

test("HTML typed by the author is shown as text, never as markup", () => {
  const html = markdownToHtml('<script>alert(1)</script> <img src=x onerror=alert(1)> & "quotes"');
  assert.doesNotMatch(html, /<script|<img/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&amp;/);
});

test("only http, https and mailto links become links", () => {
  const html = markdownToHtml("[ok](https://example.com/a_b_c) [mail](mailto:a@b.co) [bad](javascript:alert(1)) [data](data:text/html,x)");
  assert.match(html, /<a href="https:\/\/example\.com\/a_b_c"/);
  assert.match(html, /<a href="mailto:a@b\.co"/);
  assert.doesNotMatch(html, /href="javascript:|href="data:/);
  assert.match(html, /\[bad\]\(javascript:alert\(1\)\)/);
});

test("a quote in a link address can not break out of the attribute", () => {
  const html = markdownToHtml('[x](https://example.com/"onmouseover="alert(1))');
  assert.doesNotMatch(html, /"onmouseover="/);
});

test("underscores inside words and file names stay as typed", () => {
  const html = markdownToHtml("use snake_case_names and my_file_name.txt");
  assert.doesNotMatch(html, /<em>/);
});

test("the email has the footer, the one-click link and the brand, all escaped", () => {
  const { html, text } = renderNewsletterEmail({
    subject: "Hello <b>", bodyMd: "Body", unsubscribeUrl: "https://shop.example.com/unsubscribe?token=abc&x=1", brandName: "Shop & Co", settingsUrl: "https://shop.example.com/settings",
  });
  assert.match(html, /<title>Hello &lt;b&gt;<\/title>/);
  assert.match(html, /href="https:\/\/shop\.example\.com\/unsubscribe\?token=abc&amp;x=1"/);
  assert.match(html, /Unsubscribe with one click/);
  assert.match(html, /Shop &amp; Co/);
  assert.match(text, /Unsubscribe with one click: https:\/\/shop\.example\.com\/unsubscribe\?token=abc&x=1/);
  assert.match(text, /^Body\n/);
});

test("control characters are removed", () => {
  const html = markdownToHtml("a\u0000b\u0007c");
  assert.doesNotMatch(html, /[\u0000-\u0008]/);
});
