---
"@ifc-lite/ids": patch
---

An IDS entity name given as a pattern or an enumeration now meets the upper-case IFC class, case-sensitively (#ISSUE). IDS 1.0 names a class in upper case (`IFCWALL`), and IfcTester matches a pattern or an enumeration against the upper-case class. IFC Lite matched them regardless of case, against `IfcWall`, so the same IDS selected different elements in the two tools.

What changes, in the entity facet and in a partOf facet's entity:

- A pattern selects the classes whose upper-case name it matches. `IFCDISTRIBUTION.*ELEMENT` and `IFCWALL` select as before. `IfcDistribution.*Element`, `IfcWall`, `.*Wall` and `IFC[a-z]+` now select nothing. They selected the classes they match regardless of case.
- An enumeration selects the classes it lists in upper case. A value such as `IfcWall` now selects nothing. The audit already reports such a value as the error `E_IFC_ENTITY_CASE`.
- On IFC2X3, the occurrence/type mapping table reads the same way: a pattern `IFCAIRTERMINAL` selects a flow terminal typed by an air terminal type, and `IfcAirTerminal` no longer does.
- In a requirement, an element whose class the name no longer selects fails, where it passed.
- A specification whose applicability is such a pattern now selects nothing: with `minOccurs="1"` it fails, and with `maxOccurs="0"` it passes where it failed. The audit does not report a PascalCase pattern.

What does not change:

- A simple value. The entity facet still rejects one that is not upper case (buildingSMART's `entity/invalid-entities_must_be_specified_as_uppercase_strings`), and an upper-case one selects as before. A partOf entity given as a simple value is still compared regardless of case.
- Predefined types, which were already compared case-sensitively.
- `filterByEntityFacet`, the type-index prefilter. It still collects candidates regardless of case; the facet check above decides.
