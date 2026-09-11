/**
 * 观察包管线配置：静默窗、截图、遮罩预算。
 * 全景截图为多帧视口数组（禁止竖向拼接长图）。
 */

export const PAGE_PIPELINE_CONFIG = {
  /** 视口内有意义突变后的静默窗（ms） */
  quietMs: 800,
  /** 静默等待硬上限（ms），永不因动画挂死 */
  deadlineMs: 4_000,
  /** Agent 观察路径更短的静默（SERP 热区动画多） */
  agentQuietMs: 600,
  agentDeadlineMs: 3_000,
  /** 判定「有意义」的最小元素面积（px²） */
  minMutationArea: 80,
  /** 全景最多视口帧数 */
  panoramaMaxFrames: 5,
  /** JPEG 质量 0–100 */
  jpegQuality: 48,
  /** 单帧最长边（px） */
  maxShotEdge: 1024,
  /** 帧间滚动后短暂等待（ms） */
  scrollSettleMs: 120,
  /** 结构哈希近似相同的阈值（0–1，1=完全相同）—— 用于 Delta Skip */
  structureSimilarityReuse: 0.92,
  /** 同遮罩指纹短窗（ms） */
  overlayRecurrenceWindowMs: 15_000,
  /** 同指纹出现次数达到后停止追逐 */
  overlayRecurrenceStopAt: 3,
  /** 无障碍树文本上限 */
  a11yMaxChars: 6_000,
  /** Agent 索引 DOM 提取硬超时（ms）— 百度等多 frame 页可卡 evaluate */
  extractTimeoutMs: 12_000,
} as const;

export type PagePipelineConfig = typeof PAGE_PIPELINE_CONFIG;
