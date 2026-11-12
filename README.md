# In-Motion + Static Weighbridge Dashboard

**SMS • Digital Transformation & Automation | Jindal Steel**  
Production-style operational monitoring and analytical intelligence system comparing **Static Weighbridge** hot-metal torpedo weighments with **In-Motion Weighbridge (IMWB)** dynamic weighments.

---

## 1. Architecture Overview

```text
BF1 Static DB ──┐
                ├── dbo.v_static_hm_weight_combined ──┐
BF2 Static DB ──┘                                     │
                                                      ├── dbo.dashboard ── Flask API ── Browser Client
PostgreSQL IMWB ── dbo.v_imwb_consolidated ───────────┘