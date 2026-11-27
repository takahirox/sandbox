# Qwen3 0.6B livestream adapter

The browser loads a task-specific LoRA adapter over the Japanese-adapted
Qwen3 0.6B WBD Q8_0 model. The model and adapter use [Apache 2.0](./LICENSE).

- [Original Qwen3 model and tokenizer](https://huggingface.co/Qwen/Qwen3-0.6B/tree/c1899de289a04d12100db370d81485cdf75e47ca)
- [Frozen Q8_0 GGUF weights](https://huggingface.co/webbigdata/Qwen3-0.6B_WBD/tree/789a31e3011376f1c5f1ace071ba81f39ed20b5a)
- [Trained GGUF adapter](./resolve/e3866302664199c2/livestream.gguf)
- [Training source, dataset and reproduction instructions](https://github.com/takahirox/sandbox/tree/main/scripts/livestream-training)

The 919,968-byte adapter has SHA-256
`e3866302664199c20d0c4b35fee826b06562ebb9782fd46059e35ea0de1d2192`.
