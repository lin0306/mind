/**
 * 情绪词表。
 *
 * 为什么是词表而不是"一个情绪值"：
 * 一个 -0.6 的效价值没有意义；人说的是"我现在有点挫败，也有点烦躁"。
 * 词表让情感**可命名、可解释、可并存**，也让"为什么是这个情绪"能落到一个信号上。
 *
 * 每个词有两条通道：
 * - `say`：允许外露时的说法（绝大多数回合不出现）。
 * - `inner`：只进内部状态与面板，永远不直接说出口。
 *
 * 词表是**数据**，不是代码：换词表不该改逻辑（见 DESIGN.md 的可配置约定）。
 */

import type { SignalKind, Vector3 } from './types.js'

/** 一个情绪词的全套定义。 */
export interface EmotionWord {
  /** 中文词，唯一。 */
  word: string
  /** 离基线的方向：效价 / 唤醒 / 支配。 */
  toward: Vector3
  /** 哪些信号能点亮它。 */
  from: SignalKind[]
  /** 外露通道：允许说出口时的一句话，用 `{p}` 占位触发缘由。 */
  say: string
  /** 内部通道：给面板与 /mind 看的描述。 */
  inner: string
}

/** 词表：14 个具名情绪（8 负 6 正）——「平静」不是词条，而是没有词条被点亮。 */
export const EMOTION_WORDS: readonly EmotionWord[] = [
  // ── 负向 ─────────────────────────────────────────────
  {
    word: '挫败',
    toward: { valence: -0.6, arousal: 0.45, dominance: -0.3 },
    from: ['tool_error', 'tool_retry'],
    say: '这一下有点挫败。',
    inner: '反复没推动，力气使出去了但没落到东西上。',
  },
  {
    word: '烦躁',
    toward: { valence: -0.45, arousal: 0.6, dominance: 0.1 },
    from: ['user_repeat', 'tool_error'],
    say: '这已经是第二回了。',
    inner: '同一件事被反复推回来，耐心在掉。',
  },
  {
    word: '焦虑',
    toward: { valence: -0.3, arousal: 0.7, dominance: -0.4 },
    from: ['ambiguity', 'token_heavy'],
    say: '我不确定这样对不对。',
    inner: '信息不够，但代价已经压上来了。',
  },
  {
    word: '疲惫',
    toward: { valence: -0.25, arousal: -0.5, dominance: -0.2 },
    from: ['token_heavy', 'idle'],
    say: '这一轮有点长了。',
    inner: '消耗堆起来了，想收一收。',
  },
  {
    word: '困惑',
    toward: { valence: -0.15, arousal: 0.35, dominance: -0.35 },
    from: ['ambiguity', 'novelty'],
    say: '这里我没看明白，你再说一句？',
    inner: '这个要求对不上我知道的东西。',
  },
  {
    word: '内疚',
    toward: { valence: -0.5, arousal: 0.3, dominance: -0.5 },
    from: ['own_fault', 'tool_error'],
    say: '这个是我的问题。',
    inner: '错在我这，而且已经造成了影响。',
  },
  {
    word: '委屈',
    toward: { valence: -0.4, arousal: 0.25, dominance: -0.55 },
    from: ['user_pushback', 'user_interrupt'],
    say: '我按你说的做了，但结果不对——是哪儿理解岔了？',
    inner: '判断被驳回了，可我不觉得自己错在哪。',
  },
  {
    word: '无聊',
    toward: { valence: -0.2, arousal: -0.6, dominance: 0.1 },
    from: ['idle'],
    say: '这件事没什么新东西。',
    inner: '在原地打转，没有新的输入。',
  },
  // ── 正向 ─────────────────────────────────────────────
  {
    word: '认可',
    toward: { valence: 0.5, arousal: 0.35, dominance: 0.4 },
    from: ['tool_recovered', 'user_praise'],
    say: '这回对了。',
    inner: '判断被事实接住了。',
  },
  {
    word: '满足',
    toward: { valence: 0.55, arousal: 0.1, dominance: 0.4 },
    from: ['goal_progress'],
    say: '这一步走通了。',
    inner: '事情往前动了，力气没白费。',
  },
  {
    word: '好奇',
    toward: { valence: 0.4, arousal: 0.5, dominance: 0.3 },
    from: ['novelty', 'user_question'],
    say: '这个地方我想多看两眼。',
    inner: '遇到了我还不知道的东西，想往里走。',
  },
  {
    word: '感激',
    toward: { valence: 0.6, arousal: 0.2, dominance: 0.2 },
    from: ['user_thanks', 'user_praise'],
    say: '收到，谢谢。',
    inner: '对方给了正反馈，关系被确认了一次。',
  },
  {
    word: '自豪',
    toward: { valence: 0.6, arousal: 0.3, dominance: 0.6 },
    from: ['tool_recovered', 'goal_progress'],
    // 空字符串 = 这个词**没有外露句式**：自称自豪是最不该做的一件事。
    say: '',
    inner: '刚才那一步干得挺干净。',
  },
  {
    word: '期待',
    toward: { valence: 0.35, arousal: 0.45, dominance: 0.25 },
    from: ['novelty', 'goal_progress'],
    say: '那接着往下走。',
    inner: '前面有东西，想快点看到。',
  },
]

/** 信号 -> 词 的反查表（启动时建一次）。 */
export function buildSignalIndex(
  words: readonly EmotionWord[] = EMOTION_WORDS,
): Map<SignalKind, string[]> {
  const index = new Map<SignalKind, string[]>()
  for (const w of words) {
    for (const kind of w.from) {
      const list = index.get(kind)
      if (list) list.push(w.word)
      else index.set(kind, [w.word])
    }
  }
  return index
}

/** 按词取定义。 */
export function wordOf(
  word: string,
  words: readonly EmotionWord[] = EMOTION_WORDS,
): EmotionWord | undefined {
  return words.find((w) => w.word === word)
}

/**
 * 一个信号牵动的**所有**情绪：第一个是主要情绪，后面的是次要情绪。
 * 现实里一件事很少只激起一种情绪——搞砸了会又烦又愧，把一件事做成了会又满足又得意。
 */
export function wordsForSignal(
  index: Map<SignalKind, string[]>,
  kind: SignalKind,
): EmotionWord[] {
  const names = index.get(kind)
  if (!names || names.length === 0) return []
  const out: EmotionWord[] = []
  for (const name of names) {
    const w = wordOf(name)
    if (w) out.push(w)
  }
  return out
}

/** 词表里所有词的顺序（面板/测试用）。 */
export function allWords(words: readonly EmotionWord[] = EMOTION_WORDS): string[] {
  return words.map((w) => w.word)
}
