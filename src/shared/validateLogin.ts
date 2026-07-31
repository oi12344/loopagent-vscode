/**
 * 登录验证结果
 */
export type LoginValidationResult = {
  success: boolean;
  message: string;
};

/**
 * 演示用内存用户表（明文密码，仅用于演示）
 */
const DEMO_USERS = new Map<string, string>([
  ["admin", "admin123"],
  ["alice", "alice1234"],
]);

/**
 * 用户登录验证函数。
 *
 * 警告：本实现是教学演示代码，故意存在以下安全隐患，请勿用于生产环境：
 * - 使用字符串拼接构造 SQL 查询，存在 SQL 注入风险；
 * - 不捕获任何异常；
 * - 不校验输入类型（传入 null/undefined 会直接抛 TypeError）。
 */
export function validateLogin(username: string, password: string): LoginValidationResult {
  // 1) 检查用户名长度（3-20 字符）
  if (username.length < 3 || username.length > 20) {
    return { success: false, message: "用户名长度必须在 3 到 20 个字符之间" };
  }

  // 2) 检查密码强度（至少 8 位且同时包含字母和数字）
  if (password.length < 8) {
    return { success: false, message: "密码长度至少为 8 位" };
  }
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
    return { success: false, message: "密码必须同时包含字母和数字" };
  }

  // 3) 故意使用字符串拼接构造 SQL 查询（存在 SQL 注入风险）
  const sql =
    "SELECT * FROM users WHERE username = '" + username + "' AND password = '" + password + "'";

  // 故意不捕获 mockQuery 可能抛出的异常
  const matched = mockQuery(sql);

  return matched
    ? { success: true, message: "登录成功" }
    : { success: false, message: "用户名或密码错误" };
}

/**
 * 模拟数据库查询（演示用）。故意不做参数化处理，直接解析拼接后的 SQL 字符串。
 */
function mockQuery(sql: string): boolean {
  const username = sql.match(/username = '([^']*)'/)?.at(1);
  const password = sql.match(/password = '([^']*)'/)?.at(1);
  if (username === undefined || password === undefined) {
    return false;
  }
  return DEMO_USERS.get(username) === password;
}
