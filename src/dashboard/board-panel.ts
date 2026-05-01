/**
 * <board-panel> Web Component.
 * Kanban board for project tracking with 4 columns:
 * In Progress, Queued, Awaiting Ben, Recently Completed.
 *
 * Usage:
 *   const panel = document.querySelector('board-panel');
 *   panel.fetchProjects();  // load + render
 */

import { state, authHeaders } from '/dashboard/assets/state.ts';
import { esc, timeAgo } from '/dashboard/assets/utils.ts';

const COLUMNS = [
  { key: 'in_progress', label: 'In Progress', color: 'var(--accent)' },
  { key: 'queued', label: 'Queued', color: 'var(--text-dim)' },
  { key: 'awaiting_ben', label: 'Awaiting Ben', color: 'var(--yellow)' },
  { key: 'completed', label: 'Recently Completed', color: 'var(--green)' },
];

class BoardPanel extends HTMLElement {
  _projects = [];
  _respondingTo = null;

  async fetchProjects() {
    try {
      const res = await fetch('/api/projects', { headers: authHeaders() });
      if (res.ok) {
        this._projects = await res.json();
        this.render();
      }
    } catch (err) {
      console.error('[board] fetch failed:', err);
    }
  }

  render() {
    const projects = state.projects || this._projects;

    this.innerHTML = `
      <div class="board-header">
        <h2>Board</h2>
      </div>
      <div class="board-columns">
        ${COLUMNS.map(col => {
          const items = projects.filter(p => p.status === col.key);
          return `
            <div class="board-column">
              <div class="board-column-header" style="border-top: 3px solid ${col.color}">
                <span class="board-column-title">${col.label}</span>
                <span class="board-column-count">${items.length}</span>
              </div>
              <div class="board-column-cards">
                ${items.length === 0 ? '<div class="board-empty">No items</div>' : items.map(p => this._renderCard(p)).join('')}
              </div>
            </div>
          `;
        }).join('')}
      </div>
      ${this._respondingTo !== null ? this._renderRespondModal(projects) : ''}
    `;
    this._attachEvents();
  }

  _renderCard(project) {
    const agentBadge = project.assigned_agent
      ? `<span class="board-card-agent">${esc(project.assigned_agent)}</span>`
      : '';
    const desc = project.description
      ? `<p class="board-card-desc">${esc(project.description).substring(0, 120)}${project.description.length > 120 ? '…' : ''}</p>`
      : '';
    const responseNeeded = project.response_needed
      ? `<p class="board-card-response-needed">${esc(project.response_needed)}</p>`
      : '';

    const statusButtons = COLUMNS
      .filter(c => c.key !== project.status && c.key !== 'completed')
      .map(c => `<button class="board-status-btn" data-id="${project.id}" data-status="${c.key}" title="Move to ${c.label}">${c.label}</button>`)
      .join('');

    const completeBtn = project.status !== 'completed'
      ? `<button class="board-status-btn board-complete-btn" data-id="${project.id}" data-status="completed" title="Mark completed">✓ Done</button>`
      : '';

    const respondBtn = project.status === 'awaiting_ben'
      ? `<button class="board-respond-btn" data-id="${project.id}">Respond</button>`
      : '';

    return `
      <div class="board-card" data-id="${project.id}">
        <div class="board-card-top">
          <span class="board-card-title">${esc(project.title)}</span>
          ${agentBadge}
        </div>
        ${desc}
        ${responseNeeded}
        <div class="board-card-meta">
          <span class="board-card-time">${timeAgo(project.updated_at)}</span>
        </div>
        <div class="board-card-actions">
          ${respondBtn}
          ${statusButtons}
          ${completeBtn}
        </div>
      </div>
    `;
  }

  _renderRespondModal(projects) {
    const project = projects.find(p => p.id === this._respondingTo);
    if (!project) return '';
    return `
      <div class="board-modal-overlay" data-dismiss="modal">
        <div class="board-modal">
          <div class="board-modal-header">
            <h3>Respond: ${esc(project.title)}</h3>
            <button class="board-modal-close" data-dismiss="modal">&times;</button>
          </div>
          ${project.response_needed ? `<p class="board-modal-context">${esc(project.response_needed)}</p>` : ''}
          <textarea class="board-modal-input" id="boardResponseInput" placeholder="Your response (sends to dashboard + Telegram)..." rows="4"></textarea>
          <div class="board-modal-actions">
            <button class="board-modal-cancel" data-dismiss="modal">Cancel</button>
            <button class="board-modal-send" id="boardResponseSend">Send Response</button>
          </div>
        </div>
      </div>
    `;
  }

  _attachEvents() {
    // Status change buttons
    this.querySelectorAll('.board-status-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const id = e.target.dataset.id;
        const status = e.target.dataset.status;
        await fetch(`/api/projects/${id}`, {
          method: 'PATCH',
          headers: authHeaders(),
          body: JSON.stringify({ status }),
        });
      });
    });

    // Respond button
    this.querySelectorAll('.board-respond-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        this._respondingTo = parseInt(e.target.dataset.id, 10);
        this.render();
        setTimeout(() => document.getElementById('boardResponseInput')?.focus(), 50);
      });
    });

    // Modal dismiss
    this.querySelectorAll('[data-dismiss="modal"]').forEach(el => {
      el.addEventListener('click', (e) => {
        if (e.target === e.currentTarget) {
          this._respondingTo = null;
          this.render();
        }
      });
    });

    // Send response
    const sendBtn = document.getElementById('boardResponseSend');
    if (sendBtn) {
      sendBtn.addEventListener('click', async () => {
        const input = document.getElementById('boardResponseInput');
        const message = input?.value?.trim();
        if (!message || this._respondingTo === null) return;
        sendBtn.textContent = 'Sending...';
        sendBtn.disabled = true;
        try {
          await fetch(`/api/projects/${this._respondingTo}/respond`, {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({ message }),
          });
          this._respondingTo = null;
          this.render();
        } catch (err) {
          console.error('[board] respond failed:', err);
          sendBtn.textContent = 'Send Response';
          sendBtn.disabled = false;
        }
      });
    }

    // Ctrl/Cmd+Enter to send in modal
    const responseInput = document.getElementById('boardResponseInput');
    if (responseInput) {
      responseInput.addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
          e.preventDefault();
          document.getElementById('boardResponseSend')?.click();
        }
      });
    }
  }
}

customElements.define('board-panel', BoardPanel);
