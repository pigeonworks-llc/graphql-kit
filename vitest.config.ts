import { defineConfig } from 'vitest/config';

// src/ は出荷物 (graphql / graphql-yoga のみ依存)、conformance/ は架空ドメインで
// 組み合わせを確かめる場所 (@graphql-tools/schema を追加で使う)。どちらも plain node。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'conformance/**/*.test.ts'],
  },
});
