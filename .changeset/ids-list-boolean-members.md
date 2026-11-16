---
"@ifc-lite/ids": patch
---

IDS: a boolean inside a list or enumerated property value now matches the IDS boolean that names it (#ISSUE). This follows #7543, which did the same for a single value.

An `IfcPropertyListValue` or `IfcPropertyEnumeratedValue` of IFCBOOLEAN members reached the facets as the STEP tokens `.T.` and `.F.`, so `true`, `false`, `1` and `0` matched none of them. The same boolean in an `IfcPropertySingleValue` matched. IfcTester matches both.

What changes, for a list or enumerated value whose members are all IFCBOOLEAN, or all IFCLOGICAL:

- `createDataAccessor(...).getPropertySets()` gives each `.T.` member as `true` and each `.F.` member as `false` in `values`, and the display `value` reads `true, false` instead of `.T., .F.`. A server-parsed store, whose data model writes `T` and `F`, gets the same.
- A required or optional requirement with `true`, `false`, `1` or `0` now passes an element whose list holds that boolean. It failed every such element.
- A prohibited requirement now fails such an element. It passed it.
- A property applicability now selects such elements. It selected none of them.
- An `xs:enumeration` that lists `true`, `false`, `1` or `0` matches the same way.
- An `xs:enumeration` or `xs:pattern` that names the STEP token (`.T.`, `\.T\.`) no longer matches such a member. It never matched a single IFCBOOLEAN; a list member now gets the answer a single value gets for every value shape.
- A failure message shows the members as `true, false`.

What does not change:

- An unknown IFCLOGICAL member (`.U.`) names no boolean and is kept as it is. It matches no boolean literal, and the property still has a value.
- A single IFCBOOLEAN or IFCLOGICAL value, read as a boolean already.
- Members of any other type, including a label whose text is `.T.` or `T`.
- A list whose members do not share one type, which IFC does not allow (WR31), and a table: their members are kept as they are.
