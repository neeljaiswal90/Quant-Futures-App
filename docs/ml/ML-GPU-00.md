# ML-GPU-00 GPU Training Environment Benchmark

ML-GPU-00 prepares the project to use the local RTX 4080 for future offline ML
training. It is intentionally not a runtime or strategy ticket.

## Scope

- Detect local Python, PyTorch, CUDA, GPU name, GPU memory, and XGBoost GPU
  capability when those packages are installed.
- Provide a tiny synthetic tensor benchmark for PyTorch.
- Provide an optional synthetic training benchmark for PyTorch and XGBoost.
- Keep all GPU packages optional; CI must pass without PyTorch, XGBoost, CUDA,
  or an NVIDIA driver.
- Use synthetic data only.

## Non-Goals

- Do not change live runtime.
- Do not add model inference to ORCH.
- Do not modify strategy decisions.
- Do not change DATA gates.
- Do not use GPU acceleration for production parity tools yet.

## Commands

```powershell
npm run ml:gpu:check
```

Writes a JSON environment report to stdout. To persist it:

```powershell
npm run ml:gpu:check -- --out reports/ml/gpu_environment_check.json
```

Run the optional synthetic training benchmark:

```powershell
npm run ml:gpu:synthetic-benchmark -- `
  --framework auto `
  --samples 2048 `
  --features 32 `
  --epochs 20 `
  --out reports/ml/synthetic_gpu_benchmark.json
```

For CI/import-safety checks, use dry-run mode:

```powershell
npm run ml:gpu:synthetic-benchmark -- --dry-run
```

## Environment Notes

The scripts do not install GPU packages. If PyTorch is missing, install a
CUDA-enabled PyTorch build in the local training environment. If XGBoost is
missing or lacks CUDA support, install an XGBoost build appropriate for local
GPU experiments.

The environment report is operational and snapshot-like. Timings, installed
package versions, CUDA visibility, and driver state can vary by machine and day.
Do not treat these reports as replay-stable trading evidence.

## Future Use

GPU training is reserved for offline research workflows:

- Feature-table training from already verified DATA/SIM outputs.
- Walk-forward experiments over historical sessions.
- Opportunity-decay and candidate-ranking model experiments.
- Hyperparameter sweeps and model diagnostics.

GPU work remains outside live ingestion, live orchestration, risk gates, and
production parity tools until a later ticket explicitly wires those boundaries.
