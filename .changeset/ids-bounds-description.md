---
"@ifc-lite/ids": patch
---

IDS: the words for a bounds restriction now name every facet it checks (#ISSUE). Which values pass or fail does not change.

What changes:

- `formatConstraint`, and with it `expectedValue` and `failureReason`: `xs:length`, `xs:minLength` and `xs:maxLength` read `exactly 2 characters`, `>= 5 characters` and `<= 3 characters`, where they read `any value`. A restriction with both inclusive bounds keeps its other facets: `between 0 and 10 and <= 1 fraction digits`, where it read `between 0 and 10`.
- `getConstraintMismatchReason`: a text that breaks a length facet reads `"ABCD" (4 characters) must have at most 3 characters`, where it read `"ABCD" is not a valid number`. An inclusive bound is compared as the matcher compares it, without a 1e-6 tolerance, so a value just past it reads `-1e-7 must be >= 0`, where the reason was empty.
- The translated descriptions (`checkedDescription`, and `describeConstraint` of `createTranslationService`) name every bound, the lower one first: `greater than 0 and less than 5`, where only the first bound was named. Lengths, digit counts and a facet that cannot be read have words in all five locales (`at most 3 characters long`, `at most 2 digits long`, `within a restriction that cannot be read (xs:maxLength="three")`), where they read `any value` in English. The exported `en`, `de` and `fr` catalogues, and the `it` and `ru` ones, each gain six keys under `constraints.bounds`: `length`, `minLength`, `maxLength`, `totalDigits`, `fractionDigits` and `unreadable`. No key is renamed or removed.

What does not change:

- A restriction with one bound, or with only a min and max pair (`between 0 and 10`), reads as before, in every locale.
- The English expected value and reason for a facet that cannot be read.
- The order of the English expected value (`<= 10 and > 6`).
