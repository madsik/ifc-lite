---
"@ifc-lite/ids": patch
---

The IDS audit no longer reads an authored name or title as missing (#ISSUE). `parseIDS` fills a missing specification `@name` with `Specification <n>` and a missing `<title>` with `Untitled IDS`. The audit read those texts as missing wherever they came from. So a specification whose author named it `Specification 3` got the error `E_XSD_REQUIRED_ATTR` ("specification is missing a non-empty @name attribute"), and an IDS whose author wrote `<title>Untitled IDS</title>` got the missing-title warning. Both are valid in the IDS XSD.

The parser now records which names and titles it read from the XML, and the audit reads those as written. This holds for `auditIDSDocument` and for `auditIDSStructure` on a document from `parseIDS`. One consequence: an IDS with no `@name` or no `<title>`, parsed and written back with `writeIdsXml`, holds the fill-in texts in the new XML, so the audit of the new XML reads them as written and no longer reports them. The audit of the original XML still does.

What stays the same:

- `parseIDS` returns the same document as before, fill-in texts included.
- A missing, empty or blank `@name`, and a missing, empty or blank `<title>`, are still reported, with the same code, severity and message.
- A document built in code, or a copy of a parsed one (for example from `structuredClone`), is read as before: `Specification <n>` and `Untitled IDS` count as missing there.
