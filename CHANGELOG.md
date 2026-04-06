# Changelog

All notable changes to this project are documented in this file.

The format is based on Keep a Changelog,
and this project follows Semantic Versioning.

---

## [1.0.0] — 2026‑03‑22  
### Initial Public Release 🎉

PaperTrail 1.0.0 establishes a calm, reliable foundation for managing real projects, recurring work, and weekly planning — without urgency, gamification, or forced workflows.

---

### ✨ Added

#### Core Task Management
- Unified To‑Do list with global filtering and sorting
- One‑off and recurring task support
- Inbox for unassigned work
- Priority, due dates, and status tracking
- Bulk selection and batch actions

#### Work‑Week Planning
- Calendar‑based work‑week view
- Drag‑and‑drop task scheduling
- Task visibility preserved regardless of list filters
- Priority‑colored task indicators

#### Projects & Recurring Work
- Project‑based task organization with color cues
- Monthly recurring task bundles with item‑level tracking
- Per‑month recurring completion history
- Persistent bundle detail panels while working

#### Notes
- Standalone or project‑linked notes
- Inline note editing within lists
- Notes included in Weekly Review summaries

#### Weekly Review
- Dedicated Weekly Review view
- Aggregates:
  - Completed one‑off tasks
  - Recurring task logs
  - Notes created during the week
- Copy‑friendly summaries for reporting
- Optional CSV export

#### Dashboard & Insights
- Due Today, This Week, Overdue, and Recurring summaries
- Productivity heatmap visualization
- Weekly trend charts for productivity, sleep, and mood
- Automatically generated written insights based on trends

---

### 🎨 UI & UX

- Consistent top‑right task actions (Log / Edit / Delete)
- Inline meta chips that wrap naturally (no horizontal scrolling)
- Caret‑based expand/collapse interactions
- Smooth caret rotation with persistent expand state
- Theme‑aware design (Light, Dark, Vapor)
- Focus mode and compact dashboard options
- Keyboard‑friendly editing and navigation

---

### 🧠 Behavior & Design Decisions

- Monthly bundle items log immediately on check
- Unchecking bundle items requires confirmation
- Notes are optional, not required
- Recurring tasks use **Log** instead of Done/Undo by design
- No streaks, badges, or gamification
- Clear separation between planning (calendar) and execution (lists)

---

### 🛠 Technical

- Local‑first storage using IndexedDB
- Full export/import of data via JSON backups
- Session‑based UI state persistence (e.g., list visibility)
- Safe dialog polyfills for consistent behavior
- Clean re‑rendering without state loss

---

### 🧹 Removed

- Legacy To‑Do list views
- Experimental beta toggles superseded by stable defaults

---

### 🚫 Intentionally Not Included (v1)

- Cloud sync
- User accounts
- AI suggestions
- Push notifications
- Strict task hierarchies
- Kanban‑style boards

---

PaperTrail 1.0.0 represents a stable, intentional starting point focused on clarity, reliability, and follow‑through.