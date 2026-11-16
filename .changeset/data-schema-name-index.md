---
"@ifc-lite/data": patch
---

`findEntity` and `getInheritanceChain` (and so `isEntitySubtypeOf`) look names up in an index built once per schema table, instead of scanning the table (`findEntity`) or building a map of it (`getInheritanceChain`) on every call (#ISSUE). `auditIDSDocument` calls them several times per facet. The answers are identical: the same entries, in the same order, for every name and spelling, and `undefined` or `[]` for an unknown name as before. An unsupported version still rejects. No table repeats a name, so the first entry of a name, which `findEntity` returned, is also the one the inheritance walk used; a test keeps that so.
