/**
 * Bug fix suggestions for the autofix page.
 * These are randomly selected each time the user loads a new chat session.
 */
export const chatSuggestions = [
  '修复登录页面按钮点击无响应的问题',
  '解决页面加载时白屏的 bug',
  '修复表单提交后数据丢失的问题',
  '解决移动端样式错位的问题',
  '修复接口返回 500 错误',
  '解决列表滚动卡顿的性能问题',
  '修复用户头像上传失败的 bug',
  '解决日期选择器显示错误的问题',
  '修复搜索功能返回结果不准确',
  '解决页面跳转后数据未更新的问题',
  '修复下拉菜单位置偏移的 bug',
  '解决图片加载失败显示空白',
  '修复弹窗关闭后背景滚动的问题',
  '解决表格排序功能异常',
  '修复文件下载链接失效的 bug',
  '解决深色模式样式显示异常',
  '修复多语言切换后文本重叠',
  '解决输入框失焦后数据未保存',
  '修复分页组件跳转错误页码',
  '解决视频播放器控制栏显示问题'
];

/**
 * Get a random bug fix suggestion from the list.
 * Uses Math.random() which is sufficient for this use case.
 */
export function getRandomSuggestion(): string {
  const randomIndex = Math.floor(Math.random() * chatSuggestions.length);
  return chatSuggestions[randomIndex];
}
