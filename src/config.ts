/** 上游包名（npm） */
export const CODEGRAPH_PACKAGE = '@colbymchenry/codegraph';
/** rea 的 npm 包名（软依赖） */
export const REA_PACKAGE = 'rea-agents';
/** codegraph 版本兼容范围 */
export const CODEGRAPH_VERSION_RANGE = '>=1.2.0 <2';
/**
 * 允许直读/镜像的 codegraph extraction_version 白名单。
 * 上游 bump 后必须在此追加并回归测试——绝不猜未知 schema。
 * 当前实测（v1.2.0）：24
 */
export const EXTRACTION_VERSION_WHITELIST: readonly number[] = [24];

/** codegraph 的数据目录与库文件名（相对工程根） */
export const CODEGRAPH_DIR = '.codegraph';
export const UPSTREAM_DB_FILE = 'codegraph.db';
/** CodeMap 派生数据目录与核心工件（相对工程根） */
export const CODEMAP_DIR = '.codemap';
export const OWN_DB_FILE = 'codemap.db';

/** handle / 投影 TTL */
export const HANDLE_TTL_MS = 60 * 60 * 1000;
/** pierce 同步硬超时（P3 使用，先占位常量） */
export const PIERCE_TIMEOUT_MS = 120_000;
