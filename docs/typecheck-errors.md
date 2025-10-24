# TypeScript Typecheck Failures

The `npm run typecheck` task currently fails due to the following issues in the worker and shared codebases. Error locations and messages were collected from running `tsc -b tsconfig.ci.json --pretty false`.

## Shared application (`src/`)

### `src/app.tsx`
- Multiple guard checks missing around `warnRaw` and `critRaw`, which may be `undefined` when accessed. (Lines 1373-1374)
- Several state and property reads allow `undefined` to flow into string-only consumers (e.g., `status`, `string | undefined` arguments) and missing properties on aggregated objects (lines 1870-2170).
- Type mismatch when passing `{}` to APIs expecting `string`, and incorrect Cloudflare R2 bucket typing causing incompatibilities with the version from `@cloudflare/workers-types` (around line 6378).

### `src/do.ts`
- Possible `undefined` access when reading nested properties (line 203).

### `src/lib/email.ts`
- Cloudflare `R2Bucket` typings mismatch with `@cloudflare/workers-types`, especially around methods like `head` and `writeHttpMetadata` (lines 30-60).

### `src/lib/prune.ts`
- `R2Objects` collection is treated as if it exposes a `cursor` property (line 7).

### `src/lib/stats.ts`
- Optional metrics fields are used without null checks, mixing `undefined` and `null` in assignments (line 6).

### `src/lib/zip.ts`
- Potential `undefined` value being dereferenced (line 14).

### `src/reports/commissioning-pdf.ts`
- Casting an `R2Bucket` to `ReportBucket` without intermediate `unknown` conversion creates an unsafe assignment (line 91).

### `src/reports/labels-pdf.ts`
- The PDF library type definition lacks `embedSvg`, yet the code calls it directly (lines 10-18).

### `src/reports/provisioning-zip.ts`
- Mismatched Cloudflare R2 API usage: unsupported `type` option passed to `get`, `R2ObjectBody` passed where `Blob` or array-like data is expected, and union of `ArrayBuffer | R2ObjectBody` passed into `Buffer.from` (lines 6-66).

## Web app (`apps/web/src/`)

### `apps/web/src/pages/DeviceDetailPage.tsx`
- The derived alert window array includes `null` entries, conflicting with the expected `AlertWindow[]` signature (lines 570-600).
- References to `suggestion`, `fetchSuggest`, and `handleApplySuggestion` are unresolved (lines 1314-1316).

## Next steps

Each issue needs to be resolved before `npm run typecheck` will succeed. Addressing them will likely require tightening null guards, aligning Cloudflare R2 typings/usages with the latest worker APIs, and updating page-level logic to avoid `null` entries and missing references.
