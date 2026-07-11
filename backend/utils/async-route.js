// Express 4 不捕获 async 处理器的 Promise rejection（Node ≥15 未处理的 rejection 会终止进程）
// 所有 async 路由必须经此包装，把异常交给 Express 错误中间件返回 500 而不是崩溃
export const asyncRoute = fn => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};
