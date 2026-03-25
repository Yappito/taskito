# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-03-25

### 🎉 Initial Release

First public release of Taskito — a self-hosted task manager for project-scoped planning, delivery, and follow-up.

### Added

#### Task Views
- **Board view** — Kanban-style columns with drag-and-drop task management
- **List view** — Tabular view for scanning and bulk-managing tasks
- **Archive view** — Browse completed and archived tasks
- **Timeline / dependency graph** — Visualise task dependencies using ELK.js + D3.js

#### Project & Workflow Management
- Project-scoped workflows with configurable statuses and transition rules
- Final-status flag (`isFinal`) that automatically stamps a `closedAt` date on tasks
- Due-date alerts and auto-archive settings per project
- Reusable task templates and saved filter presets

#### Task Detail
- Rich task detail panel: title, description, status, assignee, due date, tags, and custom fields
- Task dependency tracking (blocking / blocked-by relationships)
- Duplicate task action
- Manual archive for completed work
- Activity history log and watcher list

#### Comments & Attachments
- Comment threads on tasks with a full activity log
- File attachments on comments with secure, authenticated download
- Inline image preview inside the task detail panel

#### Custom Fields & Tags
- Custom fields per project (text, number, date, select, and more) with ordering and required-field support
- Project tags with colour coding, merge support, and cross-view filtering

#### Search & Bulk Actions
- Project-scoped search with keyboard navigation, assignee/status context, and task-key support
- Bulk actions: update status, change assignee, apply/remove tags, archive multiple tasks at once

#### Notifications
- In-app notification centre with per-user preferences
- Mark-all-read and clear-all actions

#### User & Admin Settings
- Global settings for users, projects, workflows, tags, and custom fields
- Admin bootstrap script for first-run setup without a UI
- Profile image upload and management
- Secure password handling (Argon2 + bcrypt)

#### Deployment
- Single `docker compose up` deployment with PostgreSQL 16, nginx, and automatic migrations on boot
- GitHub Actions workflow publishing Docker images to Docker Hub on `main` and version tags
- Persistent volumes for PostgreSQL data and comment attachments

[1.0.0]: https://github.com/Yappito/taskito/releases/tag/v1.0.0
