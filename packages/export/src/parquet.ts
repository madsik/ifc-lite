/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Parquet/BOS exports are kept in a separate entrypoint to avoid bundlers
 * trying to resolve optional WASM-backed dependencies (e.g. parquet-wasm)
 * for consumers that only need GLB/JSON exports.
 */

export { ParquetExporter, type ParquetExportOptions } from './parquet-exporter.js';

