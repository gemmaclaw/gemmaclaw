<p align="center">
  <img src="site/assets/gemmaclaw-logo.svg" alt="Gemmaclaw lobster diamond logo" width="128" height="128">
</p>

# Gemmaclaw

Gemmaclaw makes it easy to run the best Gemma configuration for your hardware, out of the box. You tell it what you have (GPU, CPU, RAM), and it picks the right model, quantization, and backend so you can get a working Gemma-based assistant without tuning anything yourself. CPU-only setups are first-class, not an afterthought.

Built on top of [OpenClaw](https://github.com/openclaw/openclaw). Volunteer-driven, Gemma-first.

## Get Started

Setup, install, source-build, and command usage instructions live on the Gemmaclaw documentation site so there is one source of truth. Start with the [Setup Guide](https://gemmaclaw.github.io/gemmaclaw/setup.html).

## Documentation

- [Setup Guide](https://gemmaclaw.github.io/gemmaclaw/setup.html) - prerequisites, installation, commands, troubleshooting
- [Self-Hosting Guide](https://gemmaclaw.github.io/gemmaclaw/self-hosting.html) - find the best config for your hardware
- [Benchmark Results](https://gemmaclaw.github.io/gemmaclaw/benchmarks.html) - quality scores, speed, per-task breakdown
- [Goals and Progress](https://gemmaclaw.github.io/gemmaclaw/goals.html) - roadmap and project status

## Benchmarking

Benchmark instructions live in the [Benchmark Kit documentation](src/gemmaclaw/benchmark-kit/README.md).

## Contributing

Issues and pull requests are welcome. Keep contributions small, reproducible, and backed by data. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Links

- [Gemmaclaw Site](https://gemmaclaw.github.io/gemmaclaw/) - setup guides, benchmarks, and self-hosting configs
- [OpenClaw](https://github.com/openclaw/openclaw) - the framework Gemmaclaw is built on
- [gemma.cpp](https://github.com/google/gemma.cpp) - CPU-first Gemma backend

## Disclaimer

This project is composed of volunteers, including both Google engineers and members of the open source community. At this time, Gemmaclaw is not an official Google repository. The actions and opinions expressed in this repository do not reflect any official statements from Google, and no liability should be attributed to Google. This is a volunteer project intended to help empower people with AI, leveraging Gemma.
