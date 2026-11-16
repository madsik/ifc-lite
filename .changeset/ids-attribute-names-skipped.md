---
"@ifc-lite/parser": minor
"@ifc-lite/ids": patch
---

An IDS attribute facet now finds `GlobalId`, `OwnerHistory`, `ObjectPlacement` and `Representation` (#ISSUE). The IDS bridge read an entity's attributes through the parser's display list, which leaves out those four and `HasPropertySets` and `RepresentationMaps`. So a name pattern such as `Global.*` or an enumeration listing `GlobalId` found no attribute on any element, and `OwnerHistory`, `ObjectPlacement` and `Representation` were missing on every element, by any name.

`@ifc-lite/parser`: `extractAllEntityAttributes(store, id, { includeDisplaySkipped: true })` keeps the attributes the display list leaves out. Without the option, or with `null` or a value that is not an object, the result is the same as before.

`@ifc-lite/ids`: the bridge reads attributes with that option, for parsed entities, and without the display list for entities created in the session. What changes, for an element that sets one of the four:

- A required attribute requirement on it, by name, pattern or enumeration, passes. It failed with `ATTRIBUTE_MISSING`.
- A prohibited one fails. It passed.
- An attribute applicability on it selects the element. It selected none.
- `getAttributeNames` lists it, in schema order.
- `ObjectPlacement`, `OwnerHistory` and `Representation` reference an entity, and their value is that entity's STEP id, as for every other reference attribute (`IfcTask.TaskTime`, for example). So a value check on them, which the audit already reports as an error, compares that id, as it does for `TaskTime`.
- An entity created in the session reads a reference it sets (`'#5'`) as that STEP id too, so a created wall reports the same attribute names as a parsed one, and one that sets a placement passes a required `ObjectPlacement`.
- A name pattern or enumeration that matches one of the four and another attribute, with a value, passes when one of them meets it; IfcTester requires each. So `{GlobalId, Name}` with `[0-9]{22}` now passes where it failed.

What does not change:

- An element without the attribute still fails a required check with `ATTRIBUTE_MISSING`.
- A simple `GlobalId` check, and `getGlobalId`, `getEntityName` and `getDescription`, give the same answers.
- `HasPropertySets` and `RepresentationMaps` are lists. They now reach the same reading as every other list attribute (`IfcRelAggregates.RelatedObjects`, for example). That reading takes a list of exactly two items as its second item and drops a list of any other length, so a type with one property set still reads `HasPropertySets` as missing. That is a separate defect.
