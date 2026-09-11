// 【已迁移】本模块的实现已抽到前端共享域：web/src/core/derive.js
// 前端（本地数据模式）与后端（服务端模式）必须使用同一套成本/收益口径，
// 因此这里只做再导出，避免两份实现逐渐分叉。
// 迁移完成后（去掉 server/）本文件可直接删除。
export * from '../web/src/core/derive.js';
