// 与 server.js 的枚举保持一致；新增/修改策略或地区枚举请在此处统一维护

// 投资策略枚举（同时用于下拉选项与徽章样式）
export const INVEST_STRATEGIES = [
  { value: 'long', label: '长期持有', cls: 'badge badge-success' },
  { value: 'mid', label: '中线持有', cls: 'badge badge-info' },
  { value: 'short', label: '短线持有', cls: 'badge badge-warning' },
  { value: 'highrisk', label: '高风险博弈', cls: 'badge badge-error' },
];

// 地区枚举（下拉选项）
export const REGION_OPTIONS = [
  { value: 'hk', label: '港股' },
  { value: 'us', label: '美股' },
  { value: 'sh', label: 'A股(沪)' },
  { value: 'sz', label: 'A股(深)' },
];

// 持仓类型枚举（下拉选项）
export const TYPE_OPTIONS = [
  '股票',
  '股票型基金',
  '债券型基金',
  '货币型基金',
  'ETF',
];

// 地区短标签（用于徽章文字）
export const REGION_LABEL = { hk: '港股', us: '美股', sh: 'A股-沪', sz: 'A股-深' };

// 自动刷新间隔（毫秒），与后端调度一致
export const REFRESH_MS = 20000;
