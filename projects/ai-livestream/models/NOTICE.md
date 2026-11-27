# Qwen3 0.6B livestream adaptation

The shipped normalization weights are modified Qwen3 0.6B weights, originally
copyright 2024 Alibaba Cloud, licensed under [Apache 2.0](./LICENSE).

- [Original model and tokenizer](https://huggingface.co/Qwen/Qwen3-0.6B/tree/c1899de289a04d12100db370d81485cdf75e47ca)
- [Pinned MLC q4f16_1 conversion used for the frozen matrices and browser tokenizer](https://huggingface.co/mlc-ai/Qwen3-0.6B-q4f16_1-MLC/tree/8c14ce481d4c692769976ad52afea453a102df19)
- [Browser tensor manifest](./resolve/362c654633a66e61/tensor-cache.json) and
  [trained FP16 weights](./resolve/362c654633a66e61/norms.bin)
- [Training source, dataset and reproduction instructions](https://github.com/takahirox/sandbox/tree/main/scripts/livestream-training)

The manifest references the original quantized shards by immutable URL and
loads the modified tensors from the local overlay. The app uses the pinned
upstream chat configuration and tokenizer. The local binary's SHA-256 is
`362c654633a66e61409e09a4e24dc9de32228d5418546342c838991ba046a237`.
