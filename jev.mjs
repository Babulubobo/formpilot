try {
  const apiKey = process.env.TYPESAFE_API_KEY?.trim();
  if (!apiKey) throw new Error('请先设置 TypeSafe 官方的 TYPESAFE_API_KEY。');

  const state = process.argv[2] || '同一笔订单被扣了两次款，请退回多扣的钱。';
  const response = await fetch('https://api.typesafe.ai/v1/systemone', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(30_000),
    body: JSON.stringify({
      model: 'jev-latest',
      state,
      questions: {
        wantsRefund: {
          type: 'noul',
          instructions: '用户是否明确提出退款要求？',
        },
        department: {
          type: 'choice',
          instructions: '哪个部门最适合处理这条消息？',
          criteria: { billing: '扣款、账单或退款', technical: '软件故障', other: '其他问题' },
        },
        urgency: {
          type: 'score',
          instructions: '按问题的影响程度评估紧急程度。',
          criteria: ['低：一般咨询', '中：单个用户遇到问题', '高：服务大范围不可用'],
        },
      },
    }),
  });
  if (!response.ok) throw new Error(`TypeSafe 请求失败：HTTP ${response.status}`);
  console.log(JSON.stringify(await response.json(), null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
