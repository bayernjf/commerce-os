import type { CsIntent, IntentClassifier } from './types.js';

/**
 * Deterministic keyword intent classifier (M4 placeholder). Order matters:
 * money-out and commitment signals are checked before generic inquiry so a
 * message is never under-graded.
 */
const RULES: ReadonlyArray<{ intent: CsIntent; keywords: readonly string[] }> = [
  {
    intent: 'refund_request',
    keywords: ['退款', '退钱', '退货', '不想要了', '申请退', '退掉', '退回'],
  },
  {
    intent: 'compensation_request',
    keywords: ['赔偿', '补偿', '赔我', '赔钱', '赔付', '补发'],
  },
  {
    intent: 'promise_request',
    keywords: ['保证', '一定', '必须', '承诺', '确保', '包会', '包到', '肯定', '百分百', '100%'],
  },
  {
    intent: 'logistics_inquiry',
    keywords: ['物流', '快递', '到哪了', '什么时候到', '发货', '签收', '运单', '几天到'],
  },
  {
    intent: 'product_inquiry',
    keywords: ['尺寸', '规格', '材质', '有没有货', '多少钱', '尺码', '颜色', '怎么选', '适合'],
  },
];

export class RuleIntentClassifier implements IntentClassifier {
  classify(text: string): CsIntent {
    const normalized = text.toLowerCase();
    for (const rule of RULES) {
      if (rule.keywords.some((kw) => normalized.includes(kw.toLowerCase()))) {
        return rule.intent;
      }
    }
    return 'other';
  }
}
