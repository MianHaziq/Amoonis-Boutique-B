# Git remotes and deployment

This project uses **two GitHub remotes**: one for day‑to‑day development and one the client uses for **deployments**.

## Remotes

| Remote name   | Repository | Role |
|---------------|------------|------|
| **`origin`**  | `https://github.com/MianHaziq/Amoonis-Boutique-B.git` | Primary repo (clone, pull, normal pushes). |
| **`amoonbloom`** | `https://github.com/amoonbloom/amoonbloom-backend.git` | Client repo; CI/hosting is wired to this remote. |

Your local **`main`** branch should **track `origin/main`** so `git pull` and status messages refer to the primary repo.

---

## First-time setup on an existing clone

If someone clones from **origin** only, add the deployment remote once:

```bash
git remote add amoonbloom https://github.com/amoonbloom/amoonbloom-backend.git
git remote -v
```

If **`amoonbloom`** was already added, you will see an error; in that case you can skip the `add` or run:

```bash
git remote remove amoonbloom
git remote add amoonbloom https://github.com/amoonbloom/amoonbloom-backend.git
```

Ensure **`main`** tracks **origin**:

```bash
git branch --set-upstream-to=origin/main main
```

---

## Everyday workflow (after you commit)

Push to **both** remotes so GitHub and the deployment repo stay in sync:

```bash
git push origin main
git push amoonbloom main
```

One line (PowerShell or bash):

```bash
git push origin main && git push amoonbloom main
```

---

## Pull and sync

Update from the **primary** repo:

```bash
git pull origin main
```

Fetch from **both** without merging:

```bash
git fetch origin
git fetch amoonbloom
```

Compare local `main` to each remote:

```bash
git log --oneline main..origin/main
git log --oneline main..amoonbloom/main
```

---

## New machine: clone and add second remote

```bash
git clone https://github.com/MianHaziq/Amoonis-Boutique-B.git
cd Amoonis-Boutique-B
git remote add amoonbloom https://github.com/amoonbloom/amoonbloom-backend.git
git branch --set-upstream-to=origin/main main
```

---

## Optional: push both with a Git alias

Add once (global example):

```bash
git config --global alias.push-both '!git push origin main && git push amoonbloom main'
```

Then run:

```bash
git push-both
```

---

## Troubleshooting

- **`Permission denied` or `403`** when pushing to **amoonbloom**: you need write access to [amoonbloom/amoonbloom-backend](https://github.com/amoonbloom/amoonbloom-backend); use SSH or a credential that has access (`https://` vs `git@github.com:amoonbloom/amoonbloom-backend.git`).
- **`git pull` pulls from the wrong remote**: reset upstream with `git branch --set-upstream-to=origin/main main`.
- **Branches diverged on `amoonbloom`**: coordinate with the team; usually you rebase or merge on **`main`** locally, then push again to **both** remotes. Avoid `git push --force` unless you intend to rewrite published history.
