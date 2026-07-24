# Interview Auctions

A farm equipment auction platform. You'll fix a bug to get oriented, then build features on top of a working app.

## Prerequisites

- **Node.js** (required regardless of backend choice) — [nodejs.org/en/download](https://nodejs.org/en/download)
- **Python** (only required if using the Python backend) — [python.org/downloads](https://www.python.org/downloads)

## Setup

### Frontend

```bash
npm install
npm run dev
```

Runs at `http://localhost:5173`.

### Backend — pick one

Choose either TypeScript or Python. Both backends are equivalent — pick whichever you're most comfortable with and stick with it.

**TypeScript (Express)**
```bash
cd server/typescript
npm install
npm run dev
```
Runs at `http://localhost:3001`.

**Python (FastAPI)**
```bash
cd server/python
pip install -r requirements.txt
fastapi dev main.py --port 3001
```
Runs at `http://localhost:3001`.

> The frontend proxies `/api` to `localhost:3001` regardless of which backend you run.
> To use port 8000 instead, update the proxy target in `vite.config.ts`.

---

## What to expect

We expect this to take 1–2 hours. Start with task 0, then work on the tasks you've been assigned.

**You can use any resource you want** — the internet, AI, documentation, anything. There are no restrictions. What matters is that you can explain what you built and why you made the choices you did. You'll walk through your code with us afterward, so make sure you understand it.

**Depth over breadth.** A well-implemented task with clear reasoning is better than several half-finished ones. Don't rush to complete more tasks at the expense of the ones you've started.

**Tests are not required.** Given the time constraint, focus on working, well-reasoned code. If writing tests helps you, go for it, but don't feel obligated.

**There are no trick questions in the tasks.** The requirements say what they mean. When something is left unspecified, that's intentional — use your judgment and be ready to explain the call you made.

---

## Committing

Commit after each task. It doesn't need to be clean — just a checkpoint so we can review your work task by task. We'll be looking at the history during the code review.

## Submission

You'll receive this project as a zip file. To submit:

1. Unzip the folder and initialize it as a git repository if it isn't already (`git init`)
2. Do your work, committing after each task as described above
3. Create a **public** repository on GitHub (or another public git host)
4. Push your code to it
5. Send us the link to your repository
