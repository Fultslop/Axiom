# Arrow Functions Implementation — Review Action Items

Source: Implementation Audit Report (2026-04-17)

## Action Items

### 1. Resolve `extractContractTagsForFunctionLike` export deviation

**Status:** Partially Met  
**Location:** `src/jsdoc-parser.ts`

The plan specifies that `extractContractTagsForFunctionLike` should be exported from `jsdoc-parser.ts`. The implementation keeps it as a private (non-exported) function because knip would flag an unused export.

**Decision required:** Choose one of:
- [ ] Accept the deviation — update the plan to reflect that the function is intentionally private, since `extractContractTags` delegates to it and the public API is unchanged.
- [ ] Export it and add a direct test or re-export in `index.ts` to satisfy knip's unused-export rule.

---

*All other deviations identified in the audit are either neutral (defensive guards, minor refactors) or positive improvements (locationNode parameter, keepContracts threading, unsupported-form warnings). No further action required for those items.*
