const vscode = acquireVsCodeApi()
let currentBoard = null
let currentWorkspaceUri = ''
let expandedTasks = new Set()
let currentEditingTask = null
let currentEditingColumn = null
let isEditMode = false
let currentTagFilter = ''
let currentSort = 'none'
let currentDetailTask = null
let currentDetailColumn = null
let detailReturnTask = null
let detailReturnColumn = null

// Restore detail modal state after HTML replacement (extension replaces entire HTML on every change)
const _savedState = vscode.getState()
if (_savedState && _savedState.detailTask) {
  currentDetailTask = _savedState.detailTask
  currentDetailColumn = _savedState.detailColumn
}

// Listen for messages from the extension
window.addEventListener('message', event => {
  const message = event.data
  switch (message.type) {
    case 'updateBoard':
      currentBoard = message.board
      if (message.workspaceUri) {
        currentWorkspaceUri = message.workspaceUri
      }
      renderBoard()
      refreshTaskDetailModal()
      break
    case 'toggleTaskExpansion':
      // Open detail modal instead of inline expand
      if (currentBoard) {
        for (const col of currentBoard.columns) {
          const task = col.tasks.find(t => t.id === message.taskId)
          if (task) {
            openTaskDetailModal(message.taskId, col.id)
            break
          }
        }
      }
      break
    case 'imageInserted':
      insertImageIntoDescription(message.markdownText)
      break
  }
})

// Get display ID from task (TSK-N format stored in task.id)
function getTaskDisplayId(task) {
  if (task.id && task.id.match(/^TSK-\d+$/)) {
    return task.id
  }
  return null
}

// Copy task ID to clipboard with visual feedback
function copyTaskId(event, badge, taskId) {
  event.stopPropagation()
  navigator.clipboard.writeText(taskId)

  // Brief green flash on the badge
  badge.classList.add('copied')
  setTimeout(() => badge.classList.remove('copied'), 1200)

  // Floating tooltip above badge
  const tooltip = document.createElement('span')
  tooltip.className = 'copy-tooltip'
  tooltip.textContent = '\u2713 Copied!'
  badge.appendChild(tooltip)

  setTimeout(() => {
    tooltip.remove()
  }, 1200)
}

// Calculate deadline remaining time
function getDeadlineInfo (dueDate) {
  if (!dueDate) return null

  const today = new Date()
  const deadline = new Date(dueDate)
  const diffTime = deadline - today
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24))

  let status, text
  if (diffDays < 0) {
    status = 'overdue'
    text = `Overdue ${Math.abs(diffDays)} days`
  } else if (diffDays === 0) {
    status = 'urgent'
    text = 'Due today'
  } else if (diffDays === 1) {
    status = 'urgent'
    text = 'Due tomorrow'
  } else if (diffDays <= 3) {
    status = 'upcoming'
    text = `${diffDays} days left`
  } else {
    status = 'normal'
    text = `${diffDays} days left`
  }

  return { status, text, days: diffDays }
}

// Calculate steps progress
function getStepsProgress (steps) {
  if (!steps || steps.length === 0) {
    return { completed: 0, total: 0 }
  }
  
  const completed = steps.filter(step => step.completed).length
  return { completed, total: steps.length }
}

// Column status dot color mapping (GitHub Projects V2 style)
function getColumnDotColor(title) {
  const t = title.toLowerCase()
  if (t.includes('backlog')) return 'dot-gray'
  if (t.includes('todo')) return 'dot-blue'
  if (t.includes('progress')) return 'dot-yellow'
  if (t.includes('blocked')) return 'dot-red'
  if (t.includes('review')) return 'dot-purple'
  if (t.includes('done')) return 'dot-green'
  return 'dot-default'
}

// Render Kanban board based on filter conditions and sorting settings
// Column tab slider — compact navigation
let activeTabIndex = 0

function renderColumnTabs(columns) {
  const tabsContainer = document.getElementById('column-tabs')
  const slider = document.getElementById('column-tab-slider')
  if (!tabsContainer || !slider) return

  // Remove old tabs (keep slider)
  tabsContainer.querySelectorAll('.column-tab').forEach(t => t.remove())

  columns.forEach((col, i) => {
    const tab = document.createElement('span')
    tab.className = 'column-tab' + (i === activeTabIndex ? ' active' : '')
    const taskCount = col.tasks ? col.tasks.length : 0
    const dotColor = getColumnDotColor(col.title)
    tab.innerHTML = `<span class="column-tab-dot column-status-dot ${dotColor}"></span>${col.title}<span class="column-tab-count">${taskCount}</span>`
    tab.addEventListener('click', () => {
      activeTabIndex = i
      // Scroll column into view
      const colElements = document.querySelectorAll('.kanban-column')
      if (colElements[i]) {
        colElements[i].scrollIntoView({ behavior: 'smooth', inline: 'start', block: 'nearest' })
      }
      // Update active state
      tabsContainer.querySelectorAll('.column-tab').forEach(t => t.classList.remove('active'))
      tab.classList.add('active')
      updateTabSlider()
    })
    tabsContainer.insertBefore(tab, slider)
  })

  // Position slider on active tab
  requestAnimationFrame(() => updateTabSlider())
}

function updateTabSlider() {
  const tabsContainer = document.getElementById('column-tabs')
  const slider = document.getElementById('column-tab-slider')
  if (!tabsContainer || !slider) return

  const tabs = tabsContainer.querySelectorAll('.column-tab')
  const activeTab = tabs[activeTabIndex]
  if (!activeTab) {
    slider.style.display = 'none'
    return
  }

  slider.style.display = 'block'
  const containerRect = tabsContainer.getBoundingClientRect()
  const tabRect = activeTab.getBoundingClientRect()
  slider.style.width = `${tabRect.width}px`
  slider.style.transform = `translateX(${tabRect.left - containerRect.left - 2}px)`
}

function renderBoard () {
  if (!currentBoard) return

  const boardElement = document.getElementById('kanban-board')
  boardElement.innerHTML = ''

  // 分离归档列和非归档列，保持原有顺序
  const normalColumns = []
  const archivedColumns = []
  
  currentBoard.columns.forEach(column => {
    if (column.archived) {
      archivedColumns.push(column)
    } else {
      normalColumns.push(column)
    }
  })
  
  // 先渲染正常列
  normalColumns.forEach(column => {
    const columnElement = createColumnElement(column)
    boardElement.appendChild(columnElement)
  })
  
  // 如果有归档列，创建一个统一的归档列
  if (archivedColumns.length > 0) {
    const unifiedArchiveColumn = createUnifiedArchiveColumn(archivedColumns)
    boardElement.appendChild(unifiedArchiveColumn)
  }

  const controlsContainer = createControlsContainer()
  boardElement.appendChild(controlsContainer)

  setupDragAndDrop()
  setupTaskExpansionEvents()
  renderColumnTabs(normalColumns)
}

function createControlsContainer() {
  const controlsContainer = document.createElement('div')
  controlsContainer.className = 'board-controls'

  const showFiltersBtn = document.createElement('button')
  showFiltersBtn.className = 'show-filters-btn'
  showFiltersBtn.textContent = 'Show Filters'
  showFiltersBtn.onclick = () => toggleFilters(true)
  showFiltersBtn.id = 'show-filters-dynamic'

  const addColumnBtn = document.createElement('button')
  addColumnBtn.className = 'add-column-btn'
  addColumnBtn.textContent = '+ Add Column'
  addColumnBtn.onclick = () => addColumn()

  controlsContainer.appendChild(showFiltersBtn)
  controlsContainer.appendChild(addColumnBtn)

  const header = document.getElementById('kanban-header')
  if (header?.classList.contains('visible')) {
    showFiltersBtn.style.display = 'none'
  }

  return controlsContainer
}

function createColumnElement (column) {
  const columnDiv = document.createElement('div')
  columnDiv.className = 'kanban-column'
  columnDiv.setAttribute('data-column-id', column.id)

  const filteredTasks = filterTasks(column.tasks)
  const sortedTasks = sortTasks(filteredTasks)

  // 归档列默认收起
  const isArchived = column.archived || false
  const isCollapsed = isArchived
  
  if (isArchived) {
    columnDiv.classList.add('archived')
  }
  if (isCollapsed) {
    columnDiv.classList.add('collapsed')
  }

  const columnDotColor = getColumnDotColor(column.title)
  columnDiv.innerHTML = `
        <div class="column-header" draggable="true">
            <div class="column-title-section">
                <span class="column-status-dot ${columnDotColor}"></span>
                <h3 class="column-title">${column.title}${isArchived ? ' [Archived]' : ''}</h3>
                <span class="task-count">${sortedTasks.length}</span>
            </div>
            <div class="column-controls-menu">
                <button class="archive-toggle-btn" onclick="toggleColumnArchive('${column.id}')" 
                        title="${isArchived ? 'Unarchive' : 'Archive'}">
                    ${isArchived ? '📂' : '📁'}
                </button>
            </div>
        </div>
        <div class="tasks-container" id="tasks-${column.id}">
            ${sortedTasks.map(task => createTaskElement(task, column.id)).join('')}
        </div>
        <button class="add-task-btn" onclick="openTaskModal('${column.id}')">
            + Add item
        </button>
    `

  return columnDiv
}

function createTaskElement (task, columnId) {
  const priorityClass = task.priority ? `priority-${task.priority}` : ''
  const deadlineInfo = getDeadlineInfo(task.dueDate)
  const stepsProgress = getStepsProgress(task.steps)
  const acProgress = getStepsProgress(task.ac)
  const verifyProgress = getStepsProgress(task.verify)

  // Show AC progress in header if available, otherwise steps progress
  const headerProgress = acProgress.total > 0 ? acProgress : stepsProgress
  const headerProgressLabel = acProgress.total > 0 ? 'AC' : 'Steps'

  const taskDisplayId = getTaskDisplayId(task)

  const issueTag = task.tags?.find(t => /^#\d+$/.test(t))

  return `
        <div class="task-item"
             data-task-id="${task.id}"
             data-column-id="${columnId}">
            <div class="task-header">
                <div class="task-drag-handle" title="Drag to move task">⋮⋮</div>
                <div class="task-header-content">
                    ${issueTag ? `<div class="task-repo-label"><span class="task-repo-dot"></span>${issueTag}</div>` : ''}
                    <div class="task-title">${taskDisplayId ? `<span class="task-number" data-copy-id="${taskDisplayId}" title="Click to copy">${taskDisplayId}</span>` : ''}${task.title}</div>
                </div>
                <div class="task-meta">
                    ${headerProgress.total > 0
                      ? `<div class="task-steps-progress task-ac-progress${headerProgress.completed === headerProgress.total ? ' progress-complete' : ''}" title="${headerProgressLabel}: ${headerProgress.completed}/${headerProgress.total}">${headerProgress.completed}/${headerProgress.total}</div>`
                      : ''}
                </div>
            </div>

            ${createCardLabelsRow(task, deadlineInfo, priorityClass)}
            ${createTaskActions(task.id, columnId)}
        </div>
    `
}

function getTaskExpansionState(task) {
  let isExpanded = expandedTasks.has(task.id)
  if (!expandedTasks.has(task.id) && !expandedTasks.has(`manually_toggled_${task.id}`)) {
    isExpanded = task.defaultExpanded === true
    if (isExpanded) {
      expandedTasks.add(task.id)
    }
  }
  return isExpanded
}

function createStepsProgressElement(stepsProgress) {
  return stepsProgress.total > 0
    ? `<div class="task-steps-progress" title="Steps: ${stepsProgress.completed}/${stepsProgress.total}">${stepsProgress.completed}/${stepsProgress.total}</div>`
    : ''
}

function createPriorityElement(priority, priorityClass) {
  return priority
    ? `<span class="task-priority-badge ${priorityClass}">${getPriorityText(priority)}</span>`
    : ''
}

function createCardLabelsRow(task, deadlineInfo, priorityClass) {
  const hasPriority = !!task.priority
  const hasDeadline = !!deadlineInfo
  const hasTags = task.tags && task.tags.length > 0

  if (!hasPriority && !hasDeadline && !hasTags) return ''

  let html = '<div class="task-tags">'
  if (hasPriority) {
    html += createPriorityElement(task.priority, priorityClass)
  }
  if (hasDeadline) {
    html += createDeadlineElement(deadlineInfo, task.dueDate)
  }
  if (hasTags) {
    html += task.tags.map(tag => {
      const tagType = getTagType(tag)
      const dataAttr = tagType ? ` data-tag-type="${tagType}"` : ''
      return `<span class="task-tag"${dataAttr}>${tag}</span>`
    }).join('')
  }
  html += '</div>'
  return html
}

function createTaskTagsRow(task, deadlineInfo) {
  const hasTagsOrWorkload = task.workload || (task.tags && task.tags.length > 0)
  if (!hasTagsOrWorkload && !deadlineInfo) return ''

  return `
    <div class="task-tags-row">
        ${hasTagsOrWorkload ? createTaskTagsElement(task) : ''}
        ${deadlineInfo ? createDeadlineElement(deadlineInfo, task.dueDate) : ''}
    </div>
  `
}

function getTagType(tag) {
  const t = tag.toLowerCase()
  if (t === 'feature' || t === 'feat' || t.startsWith('type/feat')) return 'feature'
  if (t === 'bug' || t === 'fix' || t.startsWith('type/bug') || t.startsWith('type/fix')) return 'bug'
  if (t === 'chore' || t.startsWith('type/chore')) return 'chore'
  if (t === 'enhance' || t === 'enhancement' || t.startsWith('type/enhance')) return 'enhance'
  if (t === 'docs' || t.startsWith('type/docs')) return 'docs'
  if (t.startsWith('area/') || t === 'admin' || t === 'storefront' || t === 'checkout' || t === 'cart' || t === 'catalog' || t === 'auth' || t === 'email' || t === 'shipping') return 'area'
  return ''
}

function createTaskTagsElement(task) {
  const workloadTag = task.workload
    ? `<span class="task-tag workload-tag workload-${task.workload.toLowerCase()}">${task.workload}</span>`
    : ''
  const tags = task.tags && task.tags.length > 0
    ? task.tags.map(tag => {
        const tagType = getTagType(tag)
        const dataAttr = tagType ? ` data-tag-type="${tagType}"` : ''
        return `<span class="task-tag"${dataAttr}>${tag}</span>`
      }).join('')
    : ''

  return `<div class="task-tags">${workloadTag}${tags}</div>`
}

function createDeadlineElement(deadlineInfo, dueDate) {
  return `<div class="task-deadline deadline-${deadlineInfo.status}" title="Due date: ${dueDate}">${deadlineInfo.text}</div>`
}

function createDescriptionPreview(task) {
  if (!task.description) return ''
  // Show first 80 chars of description as preview when collapsed
  const preview = task.description.replace(/\n/g, ' ').substring(0, 80)
  const ellipsis = task.description.length > 80 ? '...' : ''
  return `<div class="task-desc-preview">${preview.replace(/</g, '&lt;').replace(/>/g, '&gt;')}${ellipsis}</div>`
}

function createProgressBar(task) {
  const acProgress = getStepsProgress(task.ac)
  const stepsProgress = getStepsProgress(task.steps)
  const progress = acProgress.total > 0 ? acProgress : stepsProgress

  if (progress.total === 0) return ''

  const pct = Math.round((progress.completed / progress.total) * 100)
  const isComplete = progress.completed === progress.total
  const fillClass = isComplete ? 'fill-complete' : (acProgress.total > 0 ? 'fill-ac' : 'fill-steps')

  return `
    <div class="task-progress-bar">
      <div class="task-progress-bar-fill ${fillClass}" style="width: ${pct}%"></div>
    </div>
  `
}

// Render markdown images as hover-preview links (like VS Code's native markdown preview)
function renderDescriptionHtml(text) {
  let safe = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

  // Convert ![alt](path) to underlined hover-trigger links
  safe = safe.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, src) => {
    let resolvedSrc = src
    if (currentWorkspaceUri && !src.startsWith('http') && !src.startsWith('vscode-')) {
      resolvedSrc = `${currentWorkspaceUri}/${src.replace(/^\//, '')}`
    }
    const displayText = alt || src.split('/').pop()
    const escapedPath = src.replace(/'/g, "\\'")
    return `<span class="image-hover-trigger" data-src="${resolvedSrc}" data-path="${escapedPath}" onclick="event.stopPropagation(); vscode.postMessage({type: 'openFile', path: '${escapedPath}'})">${displayText}</span>`
  })

  safe = safe.replace(/\n/g, '<br>')
  return safe
}

// Insert image markdown text at cursor position in description textarea
function insertImageIntoDescription(markdownText) {
  const textarea = document.getElementById('task-description')
  if (!textarea) return

  const start = textarea.selectionStart
  const end = textarea.selectionEnd
  const value = textarea.value

  // Add newline before if not at start and previous char isn't a newline
  const prefix = (start > 0 && value[start - 1] !== '\n') ? '\n' : ''
  // Add newline after
  const suffix = '\n'

  textarea.value = value.substring(0, start) + prefix + markdownText + suffix + value.substring(end)
  textarea.selectionStart = textarea.selectionEnd = start + prefix.length + markdownText.length + suffix.length
}

function createTaskDetails(task, columnId) {
  const description = task.description
    ? `<div class="task-description">${renderDescriptionHtml(task.description)}</div>`
    : ''

  const steps = task.steps && task.steps.length > 0
    ? createTaskStepsElement(task, columnId)
    : ''

  const ac = task.ac && task.ac.length > 0
    ? createChecklistElement(task, columnId, 'ac', 'AC:')
    : ''

  const verify = task.verify && task.verify.length > 0
    ? createChecklistElement(task, columnId, 'verify', 'Verify:')
    : ''

  const filesInfo = task.files
    ? `<div class="task-files"><span class="task-files-label">Files:</span> <span class="task-files-value">${renderFilesHtml(task.files)}</span></div>`
    : ''

  const info = createTaskInfoElement(task)

  return `
    <div class="task-details">
        ${description}
        ${ac}
        ${verify}
        ${steps}
        ${filesInfo}
        ${info}
    </div>
  `
}

function createTaskStepsElement(task, columnId) {
  const stepsList = task.steps.map((step, index) => `
    <div class="task-step-item" data-step-index="${index}">
        <div class="step-drag-handle">⋮⋮</div>
        <input type="checkbox" 
               ${step.completed ? 'checked' : ''} 
               onchange="updateTaskStep('${task.id}', '${columnId}', ${index}, this.checked)"
               onclick="event.stopPropagation()">
        <span class="task-step-text ${step.completed ? 'completed' : ''}">${step.text}</span>
    </div>
  `).join('')

  return `
    <div class="task-steps">
        <div class="task-steps-header">Steps:</div>
        <div class="task-steps-list" data-task-id="${task.id}" data-column-id="${columnId}">
            ${stepsList}
        </div>
    </div>
  `
}

function createChecklistElement(task, columnId, listKey, headerLabel) {
  const items = task[listKey]
  if (!items || items.length === 0) return ''

  const itemsList = items.map((item, index) => `
    <div class="task-step-item" data-step-index="${index}">
        <input type="checkbox"
               ${item.completed ? 'checked' : ''}
               onchange="updateChecklistItem('${task.id}', '${columnId}', '${listKey}', ${index}, this.checked)"
               onclick="event.stopPropagation()">
        <span class="task-step-text ${item.completed ? 'completed' : ''}">${item.text}</span>
    </div>
  `).join('')

  return `
    <div class="task-steps task-checklist-${listKey}">
        <div class="task-steps-header">${headerLabel}</div>
        <div class="task-steps-list" data-task-id="${task.id}" data-column-id="${columnId}" data-list-key="${listKey}">
            ${itemsList}
        </div>
    </div>
  `
}

function renderFilesHtml(filesText) {
  let safe = filesText
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

  // Convert [text](path) markdown links to clickable links
  safe = safe.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, text, path) => {
    const escapedPath = path.replace(/'/g, "\\'")
    return `<span class="file-link" onclick="event.stopPropagation(); vscode.postMessage({type: 'openFile', path: '${escapedPath}'})">${text}</span>`
  })

  return safe
}

function createTaskInfoElement(task) {
  const dueInfo = task.dueDate
    ? `<div class="task-info-item">
         <span class="task-info-label">Due:</span>
         <span>${task.dueDate}</span>
       </div>`
    : ''

  const workloadInfo = task.workload
    ? `<div class="task-info-item">
         <span class="task-info-label">Workload:</span>
         <span class="task-workload workload-${task.workload.toLowerCase()}">${task.workload}</span>
       </div>`
    : ''

  return `<div class="task-info">${dueInfo}${workloadInfo}</div>`
}

function createTaskActions(taskId, columnId) {
  return `
    <div class="task-actions">
        <button class="action-btn" onclick="event.stopPropagation(); editTask('${taskId}', '${columnId}')">Edit</button>
        <button class="action-btn delete" onclick="event.stopPropagation(); deleteTask('${taskId}', '${columnId}')">Delete</button>
    </div>
  `
}

// Filter tasks
function filterTasks (tasks) {
  if (!currentTagFilter) return tasks

  const filterTags = currentTagFilter
    .toLowerCase()
    .split(',')
    .map(tag => tag.trim())
    .filter(tag => tag)
  
  if (filterTags.length === 0) return tasks

  return tasks.filter(task => {
    const allTags = []
    if (task.workload) {
      allTags.push(task.workload.toLowerCase())
    }
    if (task.tags && task.tags.length > 0) {
      allTags.push(...task.tags.map(tag => tag.toLowerCase()))
    }
    
    if (allTags.length === 0) return false
    
    return filterTags.some(filterTag =>
      allTags.some(taskTag => taskTag.includes(filterTag))
    )
  })
}

// Sort tasks
function sortTasks (tasks) {
  const sorted = [...tasks]
  const priorityOrder = { high: 3, medium: 2, low: 1 }
  const workloadOrder = { Extreme: 4, Hard: 3, Normal: 2, Easy: 1 }

  switch (currentSort) {
    case 'title':
      return sorted.sort((a, b) => a.title.localeCompare(b.title))
    case 'deadline':
      return sorted.sort((a, b) => {
        if (!a.dueDate && !b.dueDate) return 0
        if (!a.dueDate) return 1
        if (!b.dueDate) return -1
        return new Date(a.dueDate) - new Date(b.dueDate)
      })
    case 'priority':
      return sorted.sort((a, b) => {
        const aPriority = priorityOrder[a.priority] || 0
        const bPriority = priorityOrder[b.priority] || 0
        return bPriority - aPriority
      })
    case 'workload':
      return sorted.sort((a, b) => {
        const aWorkload = workloadOrder[a.workload] || 0
        const bWorkload = workloadOrder[b.workload] || 0
        return bWorkload - aWorkload
      })
    case 'tags':
      return sorted.sort((a, b) => {
        const aTag = a.tags && a.tags[0] ? a.tags[0] : ''
        const bTag = b.tags && b.tags[0] ? b.tags[0] : ''
        return aTag.localeCompare(bTag)
      })
    default:
      return sorted
  }
}

function getPriorityText (priority) {
  const priorityMap = {
    high: 'High',
    medium: 'Medium',
    low: 'Low'
  }
  return priorityMap[priority] || ''
}

function toggleTaskExpansion (taskId) {
  expandedTasks.add(`manually_toggled_${taskId}`)
  
  if (expandedTasks.has(taskId)) {
    expandedTasks.delete(taskId)
  } else {
    expandedTasks.add(taskId)
  }

  const taskElement = document.querySelector(`[data-task-id="${taskId}"]`)
  if (taskElement) {
    taskElement.classList.toggle('expanded')
  }
}

function setupDragAndDrop() {
  setupColumnDragAndDrop()
  setupTaskStepsDragAndDrop()
  setupTaskDragAndDrop()
}

function setupTaskDragAndDrop() {
  document.querySelectorAll('.kanban-column').forEach(columnElement => {
    const columnId = columnElement.dataset.columnId
    const tasksContainer = columnElement.querySelector('.tasks-container')

    columnElement.addEventListener('dragover', e => {
      e.preventDefault()
      columnElement.classList.add('drag-over')

      const draggingElement = document.querySelector('.task-item.dragging')
      if (draggingElement) {
        const afterElement = getDragAfterTaskElement(tasksContainer, e.clientY)

        tasksContainer.querySelectorAll('.task-item').forEach(task => {
          task.classList.remove('drag-insert-before', 'drag-insert-after')
        })

        if (afterElement == null) {
          const lastTask = tasksContainer.querySelector('.task-item:last-child')
          if (lastTask && lastTask !== draggingElement) {
            lastTask.classList.add('drag-insert-after')
          }
        } else if (afterElement !== draggingElement) {
          afterElement.classList.add('drag-insert-before')
        }
      }
    })

    columnElement.addEventListener('dragleave', e => {
      if (!columnElement.contains(e.relatedTarget)) {
        columnElement.classList.remove('drag-over')
        tasksContainer.querySelectorAll('.task-item').forEach(task => {
          task.classList.remove('drag-insert-before', 'drag-insert-after')
        })
      }
    })

    columnElement.addEventListener('drop', e => {
      e.preventDefault()
      columnElement.classList.remove('drag-over')

      tasksContainer.querySelectorAll('.task-item').forEach(task => {
        task.classList.remove('drag-insert-before', 'drag-insert-after')
      })

      const taskId = e.dataTransfer.getData('text/plain')
      const fromColumnId = e.dataTransfer.getData('application/column-id')

      if (taskId && fromColumnId) {
        const dropIndex = calculateDropIndex(tasksContainer, e.clientY, fromColumnId, columnId, taskId)

        vscode.postMessage({
          type: 'moveTask',
          taskId: taskId,
          fromColumnId: fromColumnId,
          toColumnId: columnId,
          newIndex: dropIndex
        })
      }
    })

    // Make entire task card draggable (not just the handle)
    columnElement.querySelectorAll('.task-item').forEach(taskItem => {
      setupTaskCardDrag(taskItem)
    })
  })
}

function calculateDropIndex(tasksContainer, clientY, fromColumnId, toColumnId, taskId) {
  const tasks = Array.from(tasksContainer.children)
  let dropIndex = tasks.length

  for (let i = 0; i < tasks.length; i++) {
    const taskElement = tasks[i]
    const rect = taskElement.getBoundingClientRect()
    const taskCenter = rect.top + rect.height / 2

    if (clientY < taskCenter) {
      dropIndex = i
      break
    }
  }

  if (fromColumnId === toColumnId) {
    const draggedTaskElement = tasksContainer.querySelector('[data-task-id="' + taskId + '"]')
    if (draggedTaskElement) {
      const currentIndex = Array.from(tasks).indexOf(draggedTaskElement)
      if (dropIndex > currentIndex) {
        dropIndex--
      }
    }
  }

  return dropIndex
}

// Setup task expansion event delegation
function setupTaskExpansionEvents() {
  const boardElement = document.getElementById('kanban-board')
  boardElement.removeEventListener('click', handleTaskClick)
  boardElement.addEventListener('click', handleTaskClick)
}

function handleTaskClick(e) {
  const ignoredSelectors = [
    '.task-drag-handle',
    '.step-drag-handle',
    '.action-btn',
    'input[type="checkbox"]',
    '.file-link',
    '.task-number'
  ]

  for (const selector of ignoredSelectors) {
    if (e.target.matches(selector) || e.target.closest(selector)) {
      return
    }
  }

  const taskItem = e.target.closest('.task-item')
  if (taskItem) {
    const taskId = taskItem.dataset.taskId
    const columnId = taskItem.dataset.columnId
    if (taskId && columnId) {
      openTaskDetailModal(taskId, columnId)
    }
  }
}

// Setup entire task card as draggable
function setupTaskCardDrag(taskItem) {
  taskItem.draggable = true

  taskItem.addEventListener('dragstart', e => {
    // Don't drag if interacting with buttons/checkboxes
    if (e.target.matches('.action-btn, input[type="checkbox"]') || e.target.closest('.action-btn')) {
      e.preventDefault()
      return
    }
    e.dataTransfer.setData('text/plain', taskItem.dataset.taskId)
    e.dataTransfer.setData('application/column-id', taskItem.dataset.columnId)
    e.dataTransfer.effectAllowed = 'move'

    const dragImage = createDragImage(taskItem, e.offsetX, e.offsetY)
    e.dataTransfer.setDragImage(dragImage, e.offsetX, e.offsetY)

    taskItem.classList.add('dragging')
  })

  taskItem.addEventListener('dragend', () => {
    taskItem.classList.remove('dragging')
  })
}

function createDragImage(taskItem, offsetX, offsetY) {
  const dragImage = taskItem.cloneNode(true)
  dragImage.style.transform = 'rotate(3deg)'
  dragImage.style.opacity = '0.8'
  dragImage.style.position = 'absolute'
  dragImage.style.top = '-1000px'
  dragImage.style.width = taskItem.offsetWidth + 'px'
  document.body.appendChild(dragImage)
  
  setTimeout(() => document.body.removeChild(dragImage), 0)
  
  return dragImage
}

// Setup column drag and drop
function setupColumnDragAndDrop () {
  const boardElement = document.getElementById('kanban-board')
  const columns = boardElement.querySelectorAll('.kanban-column:not(.unified-archive)')
  let draggedColumnId = null
  let draggedColumnIndex = -1

  columns.forEach((column, displayIndex) => {
    const columnHeader = column.querySelector('.column-header')
    const columnId = column.getAttribute('data-column-id')

    // 跳过统一归档列
    if (columnId === 'unified-archive') return

    columnHeader.addEventListener('dragstart', e => {
      draggedColumnId = columnId
      draggedColumnIndex = displayIndex
      e.dataTransfer.setData('text/plain', columnId)
      e.dataTransfer.effectAllowed = 'move'
      column.classList.add('column-dragging')
    })

    columnHeader.addEventListener('dragend', e => {
      column.classList.remove('column-dragging')
      draggedColumnId = null
      draggedColumnIndex = -1
      columns.forEach(col => col.classList.remove('drag-over'))
    })

    column.addEventListener('dragover', e => {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      if (draggedColumnId && draggedColumnId !== columnId) {
        // 只允许正常列之间的拖拽（因为归档列现在是统一的）
        const draggedColumn = currentBoard.columns.find(col => col.id === draggedColumnId)
        const targetColumn = currentBoard.columns.find(col => col.id === columnId)
        
        if (draggedColumn && targetColumn && 
            !draggedColumn.archived && !targetColumn.archived) {
          column.classList.add('drag-over')
        }
      }
    })

    column.addEventListener('dragleave', e => {
      if (!column.contains(e.relatedTarget)) {
        column.classList.remove('drag-over')
      }
    })

    column.addEventListener('drop', e => {
      e.preventDefault()
      column.classList.remove('drag-over')

      const targetColumnId = columnId
      const targetDisplayIndex = displayIndex

      if (draggedColumnId && draggedColumnId !== targetColumnId) {
        // 只允许正常列之间的拖拽
        const draggedColumn = currentBoard.columns.find(col => col.id === draggedColumnId)
        const targetColumn = currentBoard.columns.find(col => col.id === targetColumnId)
        
        if (draggedColumn && targetColumn && 
            !draggedColumn.archived && !targetColumn.archived) {
          
          // 将显示索引转换为原始数据索引
          const fromOriginalIndex = getOriginalColumnIndex(draggedColumnId)
          const toOriginalIndex = getOriginalColumnIndex(targetColumnId)
          
          if (fromOriginalIndex !== -1 && toOriginalIndex !== -1) {
            vscode.postMessage({
              type: 'moveColumn',
              fromIndex: fromOriginalIndex,
              toIndex: toOriginalIndex
            })
          }
        }
      }
    })
  })
}

// 获取列在原始数据中的索引
function getOriginalColumnIndex(columnId) {
  if (!currentBoard) return -1
  return currentBoard.columns.findIndex(col => col.id === columnId)
}

// 创建统一的归档列
function createUnifiedArchiveColumn(archivedColumns) {
  const columnDiv = document.createElement('div')
  columnDiv.className = 'kanban-column archived unified-archive'
  columnDiv.setAttribute('data-column-id', 'unified-archive')
  
  // 统计所有归档任务的数量
  const totalArchivedTasks = archivedColumns.reduce((total, column) => {
    return total + filterTasks(column.tasks).length
  }, 0)
  
  // 默认收起状态
  columnDiv.classList.add('collapsed')
  
  columnDiv.innerHTML = `
    <div class="column-header">
      <div class="column-title-section">
        <h3 class="column-title">Archived (${archivedColumns.length})</h3>
        <button class="archive-expand-btn" onclick="toggleUnifiedArchive()" title="Expand/Collapse Archived Content">
          <span class="expand-icon">▶</span>
        </button>
      </div>
      <div class="column-controls-menu">
        <span class="task-count">${totalArchivedTasks}</span>
      </div>
    </div>
    <div class="archive-content" id="archive-content">
      ${createArchiveContent(archivedColumns)}
    </div>
  `
  
  return columnDiv
}

// 创建归档内容
function createArchiveContent(archivedColumns) {
  let content = ''
  
  archivedColumns.forEach(column => {
    const filteredTasks = filterTasks(column.tasks)
    const sortedTasks = sortTasks(filteredTasks)
    
    // 显示所有归档列，不管是否有任务
    content += `
      <div class="archive-section">
        <div class="archive-section-header">
          <div class="archive-section-info">
            <h4 class="archive-section-title">${column.title}</h4>
            <span class="archive-section-count">${sortedTasks.length}</span>
          </div>
          <button class="unarchive-btn" onclick="unarchiveColumn('${column.id}')" title="Unarchive">
            📂
          </button>
        </div>
        ${sortedTasks.length > 0 ? `
          <div class="archive-tasks">
            ${sortedTasks.map(task => createArchiveTaskElement(task, column.id)).join('')}
          </div>
        ` : `
          <div class="archive-empty-section">此列暂无任务</div>
        `}
      </div>
    `
  })
  
  return content || '<div class="archive-empty">No archived content</div>'
}

// 创建归档任务元素（简化版）
function createArchiveTaskElement(task, columnId) {
  const priorityClass = task.priority ? `priority-${task.priority}` : ''
  const deadlineInfo = getDeadlineInfo(task.dueDate)
  
  return `
    <div class="archive-task-item" data-task-id="${task.id}" data-column-id="${columnId}">
      <div class="archive-task-header">
        <span class="archive-task-title">${task.title}</span>
        ${task.priority ? `<span class="task-priority ${priorityClass}" title="Priority: ${getPriorityText(task.priority)}"></span>` : ''}
      </div>
      ${deadlineInfo ? `<div class="archive-task-deadline deadline-${deadlineInfo.status}">${deadlineInfo.text}</div>` : ''}
      ${task.tags && task.tags.length > 0 ? `<div class="archive-task-tags">${task.tags.map(tag => `<span class="archive-tag">${tag}</span>`).join('')}</div>` : ''}
    </div>
  `
}

// 切换统一归档列的展开/收起状态
function toggleUnifiedArchive() {
  const archiveColumn = document.querySelector('.unified-archive')
  const expandIcon = archiveColumn.querySelector('.expand-icon')
  
  if (archiveColumn.classList.contains('collapsed')) {
    archiveColumn.classList.remove('collapsed')
    expandIcon.textContent = '▼'
  } else {
    archiveColumn.classList.add('collapsed')
    expandIcon.textContent = '▶'
  }
}

// 取消归档列
function unarchiveColumn(columnId) {
  const column = currentBoard.columns.find(col => col.id === columnId)
  if (!column) return

  vscode.postMessage({
    type: 'toggleColumnArchive',
    columnId: columnId,
    archived: false
  })
}

function openTaskModal (columnId, taskId = null) {
  currentEditingColumn = columnId
  currentEditingTask = taskId
  isEditMode = !!taskId

  const modal = document.getElementById('task-modal')
  const modalTitle = document.getElementById('modal-title')
  const form = document.getElementById('task-form')

  modalTitle.textContent = isEditMode ? 'Edit Task' : 'Add Task'

  if (isEditMode && currentBoard) {
    populateTaskForm(columnId, taskId)
  } else {
    clearTaskForm(form)
  }

  setTimeout(() => setupModalStepsDragAndDrop(), 100)

  modal.style.display = 'block'
  document.getElementById('task-title').focus()
}

function populateTaskForm(columnId, taskId) {
  const column = currentBoard.columns.find(col => col.id === columnId)
  const task = column?.tasks.find(t => t.id === taskId)

  if (!task) return

  document.getElementById('task-title').value = task.title || ''
  document.getElementById('task-description').value = task.description || ''
  document.getElementById('task-priority').value = task.priority || ''
  document.getElementById('task-workload').value = task.workload || ''
  document.getElementById('task-due-date').value = task.dueDate || ''
  document.getElementById('task-default-expanded').checked = task.defaultExpanded || false

  clearAndPopulateTags(task.tags)
  clearAndPopulateSteps(task.steps)

}

function clearTaskForm(form) {
  form.reset()
  clearAndPopulateTags([])
  clearAndPopulateSteps([])

}

function clearAndPopulateTags(tags) {
  const tagsContainer = document.getElementById('tags-container')
  tagsContainer.querySelectorAll('.tag-item').forEach(tag => tag.remove())
  
  if (tags) {
    tags.forEach(tag => addTagToContainer(tag))
  }
}

function clearAndPopulateSteps(steps) {
  const stepsList = document.getElementById('steps-list')
  stepsList.innerHTML = ''
  
  if (steps) {
    steps.forEach(step => addStepToContainer(step.text, step.completed))
  }
}

function closeTaskModal () {
  document.getElementById('task-modal').style.display = 'none'
  currentEditingTask = null
  currentEditingColumn = null
  isEditMode = false

  // Return to detail modal if edit was opened from it
  if (detailReturnTask && detailReturnColumn) {
    var returnTask = detailReturnTask
    var returnCol = detailReturnColumn
    detailReturnTask = null
    detailReturnColumn = null
    openTaskDetailModal(returnTask, returnCol)
  }
}

// =============================================
// Task Detail Modal (read-only view with checkboxes)
// =============================================

function openTaskDetailModal (taskId, columnId) {
  if (!currentBoard) return

  const column = currentBoard.columns.find(col => col.id === columnId)
  if (!column) return
  const task = column.tasks.find(t => t.id === taskId)
  if (!task) return

  currentDetailTask = taskId
  currentDetailColumn = columnId

  const taskDisplayId = getTaskDisplayId(task)

  const modal = document.getElementById('task-detail-modal')
  document.getElementById('detail-modal-title').innerHTML = (taskDisplayId ? `<span class="task-number" data-copy-id="${taskDisplayId}" title="Click to copy">${taskDisplayId}</span> ` : '') + task.title
  document.getElementById('task-detail-body').innerHTML = renderTaskDetailContent(task, columnId)

  document.getElementById('detail-edit-btn').onclick = () => {
    detailReturnTask = taskId
    detailReturnColumn = columnId
    closeTaskDetailModal()
    editTask(taskId, columnId)
  }

  document.getElementById('detail-delete-btn').onclick = () => {
    closeTaskDetailModal()
    deleteTask(taskId, columnId)
  }

  modal.style.display = 'block'
  vscode.setState(Object.assign({}, vscode.getState() || {}, { detailTask: taskId, detailColumn: columnId }))
}

function renderTaskDetailContent (task, columnId) {
  const priorityClass = task.priority ? `priority-${task.priority}` : ''
  const deadlineInfo = getDeadlineInfo(task.dueDate)
  const stepsProgress = getStepsProgress(task.steps)
  const acProgress = getStepsProgress(task.ac)
  const verifyProgress = getStepsProgress(task.verify)

  let html = ''

  // Meta row (priority, deadline, workload)
  if (task.priority || deadlineInfo || task.workload) {
    html += '<div class="detail-meta-row">'
    if (task.priority) {
      html += `<span class="task-priority-badge ${priorityClass}">${getPriorityText(task.priority)} Priority</span>`
    }
    if (deadlineInfo) {
      html += `<span class="task-deadline deadline-${deadlineInfo.status}">${deadlineInfo.text}</span>`
    }
    if (task.workload) {
      html += `<span class="task-workload workload-${task.workload.toLowerCase()}">${task.workload}</span>`
    }
    html += '</div>'
  }

  // Tags
  if (task.tags && task.tags.length > 0) {
    html += `<div class="detail-tags-row">${task.tags.map(tag => {
      const tagType = getTagType(tag)
      const dataAttr = tagType ? ` data-tag-type="${tagType}"` : ''
      return `<span class="task-tag"${dataAttr}>${tag}</span>`
    }).join('')}</div>`
  }

  // Description
  if (task.description) {
    html += `<div class="detail-section">
      <div class="detail-section-header">Description</div>
      <div class="detail-description">${renderDescriptionHtml(task.description)}</div>
    </div>`
  }

  // AC checklist
  if (task.ac && task.ac.length > 0) {
    html += `<div class="detail-section">
      <div class="detail-section-header">AC: <span class="detail-progress">${acProgress.completed}/${acProgress.total}</span></div>
      ${renderDetailChecklist(task, columnId, 'ac')}
    </div>`
  }

  // Verify checklist
  if (task.verify && task.verify.length > 0) {
    html += `<div class="detail-section">
      <div class="detail-section-header detail-verify-header">Verify: <span class="detail-progress">${verifyProgress.completed}/${verifyProgress.total}</span></div>
      ${renderDetailChecklist(task, columnId, 'verify')}
    </div>`
  }

  // Steps
  if (task.steps && task.steps.length > 0) {
    html += `<div class="detail-section">
      <div class="detail-section-header">Steps: <span class="detail-progress">${stepsProgress.completed}/${stepsProgress.total}</span></div>
      ${renderDetailSteps(task, columnId)}
    </div>`
  }

  // Files
  if (task.files) {
    html += `<div class="detail-section">
      <div class="detail-section-header">Files</div>
      <div class="detail-files-value">${renderFilesHtml(task.files)}</div>
    </div>`
  }

  return html
}

function renderDetailChecklist (task, columnId, listKey) {
  const items = task[listKey]
  if (!items || items.length === 0) return ''

  return items.map((item, index) => `
    <div class="detail-checklist-item">
      <input type="checkbox"
             ${item.completed ? 'checked' : ''}
             onchange="updateChecklistItem('${task.id}', '${columnId}', '${listKey}', ${index}, this.checked)">
      <span class="detail-checklist-text ${item.completed ? 'completed' : ''}">${item.text}</span>
    </div>
  `).join('')
}

function renderDetailSteps (task, columnId) {
  return task.steps.map((step, index) => `
    <div class="detail-checklist-item">
      <input type="checkbox"
             ${step.completed ? 'checked' : ''}
             onchange="updateTaskStep('${task.id}', '${columnId}', ${index}, this.checked)">
      <span class="detail-checklist-text ${step.completed ? 'completed' : ''}">${step.text}</span>
    </div>
  `).join('')
}

function closeTaskDetailModal () {
  document.getElementById('task-detail-modal').style.display = 'none'
  currentDetailTask = null
  currentDetailColumn = null
  var _st = vscode.getState() || {}
  delete _st.detailTask
  delete _st.detailColumn
  vscode.setState(_st)
}

function refreshTaskDetailModal () {
  if (!currentDetailTask || !currentBoard) return

  // Search all columns for the task (it might have moved)
  let task = null
  let columnId = null
  for (const col of currentBoard.columns) {
    const found = col.tasks.find(t => t.id === currentDetailTask)
    if (found) {
      task = found
      columnId = col.id
      break
    }
  }

  if (!task) {
    closeTaskDetailModal()
    return
  }

  currentDetailColumn = columnId
  const taskDisplayId = getTaskDisplayId(task)

  const modal = document.getElementById('task-detail-modal')
  document.getElementById('detail-modal-title').innerHTML = (taskDisplayId ? `<span class="task-number" data-copy-id="${taskDisplayId}" title="Click to copy">${taskDisplayId}</span> ` : '') + task.title
  document.getElementById('task-detail-body').innerHTML = renderTaskDetailContent(task, columnId)

  document.getElementById('detail-edit-btn').onclick = () => {
    detailReturnTask = task.id
    detailReturnColumn = columnId
    closeTaskDetailModal()
    editTask(task.id, columnId)
  }

  document.getElementById('detail-delete-btn').onclick = () => {
    closeTaskDetailModal()
    deleteTask(task.id, columnId)
  }

  modal.style.display = 'block'
}

function editTask (taskId, columnId) {
  openTaskModal(columnId, taskId)
}

function deleteTask (taskId, columnId) {
  showConfirmModal('Are you sure you want to delete this task?', () => {
    vscode.postMessage({
      type: 'deleteTask',
      taskId: taskId,
      columnId: columnId
    })
  })
}

function updateTaskStep (taskId, columnId, stepIndex, completed) {
  vscode.postMessage({
    type: 'updateTaskStep',
    taskId: taskId,
    columnId: columnId,
    stepIndex: stepIndex,
    completed: completed
  })
}

function updateChecklistItem (taskId, columnId, listKey, stepIndex, completed) {
  vscode.postMessage({
    type: 'updateChecklistItem',
    taskId: taskId,
    columnId: columnId,
    listKey: listKey,
    stepIndex: stepIndex,
    completed: completed
  })
}

function showConfirmModal (message, onConfirm) {
  document.getElementById('confirm-message').textContent = message
  document.getElementById('confirm-modal').style.display = 'block'

  const confirmBtn = document.getElementById('confirm-ok-btn')
  confirmBtn.onclick = () => {
    closeConfirmModal()
    onConfirm()
  }
}

function closeConfirmModal () {
  document.getElementById('confirm-modal').style.display = 'none'
}

function showInputModal (title, message, placeholder, onConfirm) {
  document.getElementById('input-modal-title').textContent = title
  document.getElementById('input-modal-message').textContent = message
  const inputField = document.getElementById('input-modal-field')
  inputField.placeholder = placeholder
  inputField.value = ''
  document.getElementById('input-modal').style.display = 'block'

  setTimeout(() => inputField.focus(), 100)

  const confirmAction = () => {
    const value = inputField.value.trim()
    if (value) {
      closeInputModal()
      onConfirm(value)
    }
  }

  const confirmBtn = document.getElementById('input-ok-btn')
  confirmBtn.onclick = confirmAction

  inputField.onkeydown = e => {
    if (e.key === 'Enter') {
      confirmAction()
    }
  }
}

function closeInputModal () {
  document.getElementById('input-modal').style.display = 'none'
}

function toggleFilters (show) {
  const header = document.getElementById('kanban-header')
  const staticShowBtn = document.getElementById('show-filters')
  const dynamicShowBtn = document.getElementById('show-filters-dynamic')
  const body = document.body

  if (show) {
    header.classList.add('visible')
    body.classList.add('filters-visible')
    if (staticShowBtn) staticShowBtn.style.display = 'none'
    if (dynamicShowBtn) dynamicShowBtn.style.display = 'none'
  } else {
    header.classList.remove('visible')
    body.classList.remove('filters-visible')
    if (staticShowBtn) staticShowBtn.style.display = 'block'
    if (dynamicShowBtn) dynamicShowBtn.style.display = 'block'
  }
}

function addColumn () {
  showInputModal(
    'Add Column',
    'Please enter column title:',
    'Enter column title...',
    title => {
      vscode.postMessage({
        type: 'addColumn',
        title: title
      })
    }
  )
}

function toggleColumnArchive(columnId) {
  // 如果是统一归档列，不允许切换
  if (columnId === 'unified-archive') return
  
  const column = currentBoard.columns.find(col => col.id === columnId)
  if (!column) return

  const newArchivedState = !column.archived
  
  vscode.postMessage({
    type: 'toggleColumnArchive',
    columnId: columnId,
    archived: newArchivedState
  })
}

// Tag input handling
function setupTagsInput () {
  const tagsInput = document.getElementById('tags-input')
  const tagsContainer = document.getElementById('tags-container')

  const autocompleteList = document.createElement('div')
  autocompleteList.className = 'tags-autocomplete-list'
  autocompleteList.style.display = 'none'
  tagsContainer.appendChild(autocompleteList)

  let selectedIndex = -1

  tagsInput.addEventListener('input', e => {
    const inputValue = e.target.value.trim()
    if (inputValue.length > 0) {
      showAutocompleteSuggestions(inputValue, autocompleteList, tagsInput)
    } else {
      hideAutocompleteSuggestions(autocompleteList)
    }
    selectedIndex = -1
  })

  tagsInput.addEventListener('keydown', e => {
    const suggestions = autocompleteList.querySelectorAll('.autocomplete-item')
    
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault()
      
      let tagToAdd = ''
      if (selectedIndex >= 0 && suggestions[selectedIndex]) {
        tagToAdd = suggestions[selectedIndex].textContent
      } else {
        tagToAdd = tagsInput.value.trim()
      }
      
      if (tagToAdd) {
        addTagToContainer(tagToAdd)
        tagsInput.value = ''
        hideAutocompleteSuggestions(autocompleteList)
        selectedIndex = -1
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (suggestions.length > 0) {
        selectedIndex = Math.min(selectedIndex + 1, suggestions.length - 1)
        updateSelectedSuggestion(suggestions, selectedIndex)
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (suggestions.length > 0) {
        selectedIndex = Math.max(selectedIndex - 1, -1)
        updateSelectedSuggestion(suggestions, selectedIndex)
      }
    } else if (e.key === 'Escape') {
      hideAutocompleteSuggestions(autocompleteList)
      selectedIndex = -1
    }
  })

  document.addEventListener('click', e => {
    if (!tagsContainer.contains(e.target)) {
      hideAutocompleteSuggestions(autocompleteList)
      selectedIndex = -1
    }
  })
}

function getAllExistingTags() {
  const allTags = new Set()
  
  if (currentBoard?.columns) {
    currentBoard.columns.forEach(column => {
      column.tasks.forEach(task => {
        if (task.tags?.length > 0) {
          task.tags.forEach(tag => {
            if (tag?.trim()) {
              allTags.add(tag.trim())
            }
          })
        }
      })
    })
  }
  
  return Array.from(allTags).sort()
}

function showAutocompleteSuggestions(inputValue, autocompleteList, tagsInput) {
  const allTags = getAllExistingTags()
  const currentTags = getFormTags()
  
  const filteredTags = allTags.filter(tag => 
    tag.toLowerCase().startsWith(inputValue.toLowerCase()) && 
    !currentTags.includes(tag)
  )
  
  if (filteredTags.length === 0) {
    hideAutocompleteSuggestions(autocompleteList)
    return
  }
  
  autocompleteList.innerHTML = ''
  
  filteredTags.forEach((tag, index) => {
    const item = document.createElement('div')
    item.className = 'autocomplete-item'
    item.textContent = tag
    item.addEventListener('click', () => {
      addTagToContainer(tag)
      tagsInput.value = ''
      hideAutocompleteSuggestions(autocompleteList)
    })
    autocompleteList.appendChild(item)
  })
  
  autocompleteList.style.display = 'block'
}

function hideAutocompleteSuggestions(autocompleteList) {
  autocompleteList.style.display = 'none'
  autocompleteList.innerHTML = ''
}

function updateSelectedSuggestion(suggestions, selectedIndex) {
  suggestions.forEach((item, index) => {
    if (index === selectedIndex) {
      item.classList.add('selected')
    } else {
      item.classList.remove('selected')
    }
  })
}

function addTagToContainer (tagText) {
  const tagsContainer = document.getElementById('tags-container')
  const tagsInput = document.getElementById('tags-input')

  // Check if tag already exists
  const existingTags = Array.from(
    tagsContainer.querySelectorAll('.tag-item')
  ).map(tag => tag.textContent.replace('×', '').trim())

  if (existingTags.includes(tagText)) {
    return
  }

  const tagElement = document.createElement('div')
  tagElement.className = 'tag-item'
  tagElement.innerHTML = `
        ${tagText}
        <button type="button" class="tag-remove" onclick="removeTag(this)">×</button>
    `

  tagsContainer.insertBefore(tagElement, tagsInput)
}

function removeTag (button) {
  button.parentElement.remove()
}

function getFormTags () {
  const tagsContainer = document.getElementById('tags-container')
  return Array.from(tagsContainer.querySelectorAll('.tag-item')).map(tag =>
    tag.textContent.replace('×', '').trim()
  )
}

// Steps handling functions
function addStep () {
  const stepsInput = document.getElementById('steps-input')
  const stepText = stepsInput.value.trim()
  
  if (stepText) {
    addStepToContainer(stepText, false)
    stepsInput.value = ''
  }
}

function addStepToContainer (stepText, completed = false) {
  const stepsList = document.getElementById('steps-list')
  
  const stepElement = document.createElement('div')
  stepElement.className = 'step-item'
  stepElement.draggable = true
  stepElement.innerHTML = `
    <div class="step-drag-handle">⋮⋮</div>
    <input type="checkbox" ${completed ? 'checked' : ''} onchange="updateStepStatus(this)">
    <span class="step-text ${completed ? 'completed' : ''}">${stepText}</span>
    <button type="button" class="step-remove" onclick="removeStep(this)">×</button>
  `
  
  // 为整个步骤项添加事件阻止
  stepElement.addEventListener('click', e => {
    e.stopPropagation()
  })
  
  stepElement.addEventListener('mousedown', e => {
    e.stopPropagation()
  })
  
  stepsList.appendChild(stepElement)
  
  // Setup drag and drop for the new step
  setupStepDragAndDrop(stepElement)
}

function removeStep (button) {
  button.parentElement.remove()
}

function updateStepStatus (checkbox) {
  const stepText = checkbox.nextElementSibling
  if (checkbox.checked) {
    stepText.classList.add('completed')
  } else {
    stepText.classList.remove('completed')
  }
}

function getFormSteps () {
  const stepsList = document.getElementById('steps-list')
  return Array.from(stepsList.querySelectorAll('.step-item')).map(stepItem => {
    const checkbox = stepItem.querySelector('input[type="checkbox"]')
    const text = stepItem.querySelector('.step-text').textContent.trim()
    return { text, completed: checkbox.checked }
  })
}

// Setup step drag and drop for individual step items
function setupStepDragAndDrop(stepElement) {
  let longPressTimer = null
  let isDragReady = false
  
  const initializeDragMode = () => {
    isDragReady = true
    stepElement.draggable = true
    stepElement.style.cursor = 'grabbing'
    stepElement.classList.add('drag-ready')
  }
  
  const resetDragMode = () => {
    if (longPressTimer) {
      clearTimeout(longPressTimer)
      longPressTimer = null
    }
    
    if (!isDragReady) {
      stepElement.draggable = false
      stepElement.style.cursor = ''
      stepElement.classList.remove('drag-ready')
    }
  }
  
  stepElement.addEventListener('mousedown', e => {
    if (e.target.matches('input[type="checkbox"]') || e.target.matches('.step-remove')) {
      return
    }
    
    e.stopPropagation()
    
    longPressTimer = setTimeout(() => {
      initializeDragMode()
    }, 300)
  })
  
  stepElement.addEventListener('mouseup', resetDragMode)
  stepElement.addEventListener('mouseleave', resetDragMode)
  
  stepElement.addEventListener('dragstart', e => {
    if (!isDragReady) {
      e.preventDefault()
      return
    }
    
    e.stopPropagation()
    e.dataTransfer.setData('text/plain', stepElement.dataset.stepIndex || Array.from(stepElement.parentNode.children).indexOf(stepElement))
    e.dataTransfer.setData('application/step-element', 'true')
    e.dataTransfer.effectAllowed = 'move'
    
    const dragImage = createStepDragImage(stepElement, e.offsetX, e.offsetY)
    e.dataTransfer.setDragImage(dragImage, e.offsetX, e.offsetY)
    
    stepElement.classList.add('dragging')
    stepElement.classList.remove('drag-ready')
  })

  stepElement.addEventListener('dragend', e => {
    stepElement.classList.remove('dragging', 'drag-ready')
    stepElement.draggable = false
    stepElement.style.cursor = ''
    isDragReady = false
  })
  
  const dragHandle = stepElement.querySelector('.step-drag-handle')
  if (dragHandle) {
    dragHandle.addEventListener('mousedown', e => {
      e.stopPropagation()
      initializeDragMode()
    })
    
    dragHandle.addEventListener('click', e => {
      e.stopPropagation()
      e.preventDefault()
    })
  }
}

function createStepDragImage(stepElement, offsetX, offsetY) {
  const dragImage = stepElement.cloneNode(true)
  dragImage.style.transform = 'rotate(2deg)'
  dragImage.style.opacity = '0.8'
  dragImage.style.position = 'absolute'
  dragImage.style.top = '-1000px'
  dragImage.style.width = stepElement.offsetWidth + 'px'
  document.body.appendChild(dragImage)
  
  setTimeout(() => document.body.removeChild(dragImage), 0)
  
  return dragImage
}

// Setup steps list drag and drop for task details view
function setupTaskStepsDragAndDrop() {
  document.querySelectorAll('.task-steps-list').forEach(stepsList => {
    const taskId = stepsList.dataset.taskId
    const columnId = stepsList.dataset.columnId
    
    stepsList.addEventListener('dragover', e => {
      e.preventDefault()
      const draggingElement = stepsList.querySelector('.dragging')
      if (!draggingElement) return
      
      // 清除之前的插入预览
      stepsList.querySelectorAll('.task-step-item').forEach(item => {
        item.classList.remove('drag-insert-before', 'drag-insert-after')
      })
      
      const afterElement = getDragAfterElement(stepsList, e.clientY)
      if (afterElement == null) {
        // 插入到末尾
        const lastStep = stepsList.querySelector('.task-step-item:last-child')
        if (lastStep && lastStep !== draggingElement) {
          lastStep.classList.add('drag-insert-after')
        }
      } else if (afterElement !== draggingElement) {
        // 插入到指定元素之前
        afterElement.classList.add('drag-insert-before')
      }
    })

    stepsList.addEventListener('drop', e => {
      e.preventDefault()
      e.stopPropagation()
      
      // 清除插入预览
      stepsList.querySelectorAll('.task-step-item').forEach(item => {
        item.classList.remove('drag-insert-before', 'drag-insert-after')
      })
      
      // 实际移动元素
      const draggingElement = stepsList.querySelector('.dragging')
      if (draggingElement) {
        const afterElement = getDragAfterElement(stepsList, e.clientY)
        if (afterElement == null) {
          stepsList.appendChild(draggingElement)
        } else {
          stepsList.insertBefore(draggingElement, afterElement)
        }
      }
      
      // Recalculate step indices and send update to backend
      const stepItems = Array.from(stepsList.querySelectorAll('.task-step-item'))
      const newStepsOrder = []
      
      stepItems.forEach((item, newIndex) => {
        const oldIndex = parseInt(item.dataset.stepIndex)
        newStepsOrder.push(oldIndex)
        item.dataset.stepIndex = newIndex
        // Update the onchange handler with new index
        const checkbox = item.querySelector('input[type="checkbox"]')
        checkbox.setAttribute('onchange', `updateTaskStep('${taskId}', '${columnId}', ${newIndex}, this.checked)`)
      })
      
      // Send reorder message to backend
      vscode.postMessage({
        type: 'reorderTaskSteps',
        taskId: taskId,
        columnId: columnId,
        newOrder: newStepsOrder
      })
    })

    // Setup drag and drop for existing step items
    stepsList.querySelectorAll('.task-step-item').forEach(setupStepDragAndDrop)
  })
}

// Setup steps list drag and drop for modal form
function setupModalStepsDragAndDrop() {
  const stepsList = document.getElementById('steps-list')
  if (!stepsList) return

  stepsList.addEventListener('dragover', e => {
    e.preventDefault()
    const draggingElement = stepsList.querySelector('.dragging')
    if (!draggingElement) return
    
    // 清除之前的插入预览
    stepsList.querySelectorAll('.step-item').forEach(item => {
      item.classList.remove('drag-insert-before', 'drag-insert-after')
    })
    
    const afterElement = getDragAfterElement(stepsList, e.clientY)
    if (afterElement == null) {
      // 插入到末尾
      const lastStep = stepsList.querySelector('.step-item:last-child')
      if (lastStep && lastStep !== draggingElement) {
        lastStep.classList.add('drag-insert-after')
      }
    } else if (afterElement !== draggingElement) {
      // 插入到指定元素之前
      afterElement.classList.add('drag-insert-before')
    }
  })

  stepsList.addEventListener('drop', e => {
    e.preventDefault()
    
    // 清除插入预览
    stepsList.querySelectorAll('.step-item').forEach(item => {
      item.classList.remove('drag-insert-before', 'drag-insert-after')
    })
    
    // 实际移动元素
    const draggingElement = stepsList.querySelector('.dragging')
    if (draggingElement) {
      const afterElement = getDragAfterElement(stepsList, e.clientY)
      if (afterElement == null) {
        stepsList.appendChild(draggingElement)
      } else {
        stepsList.insertBefore(draggingElement, afterElement)
      }
    }
    
    // No need to send backend message for modal, will be handled on form submit
  })

  // Setup drag and drop for existing step items in modal
  stepsList.querySelectorAll('.step-item').forEach(setupStepDragAndDrop)
}

// Helper function to determine drop position for tasks
function getDragAfterTaskElement(container, y) {
  const draggableElements = [...container.querySelectorAll('.task-item:not(.dragging)')]
  
  return draggableElements.reduce((closest, child) => {
    const box = child.getBoundingClientRect()
    const offset = y - box.top - box.height / 2
    
    if (offset < 0 && offset > closest.offset) {
      return { offset: offset, element: child }
    } else {
      return closest
    }
  }, { offset: Number.NEGATIVE_INFINITY }).element
}

// Helper function to determine drop position for steps
function getDragAfterElement(container, y) {
  const draggableElements = [...container.querySelectorAll('.task-step-item:not(.dragging), .step-item:not(.dragging)')]
  
  return draggableElements.reduce((closest, child) => {
    const box = child.getBoundingClientRect()
    const offset = y - box.top - box.height / 2
    
    if (offset < 0 && offset > closest.offset) {
      return { offset: offset, element: child }
    } else {
      return closest
    }
  }, { offset: Number.NEGATIVE_INFINITY }).element
}

// Setup steps input handling
function setupStepsInput () {
  const stepsInput = document.getElementById('steps-input')

  stepsInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault()
      addStep()
    }
  })
}

// Setup description textarea: image paste handling
function setupDescriptionHandlers() {
  const textarea = document.getElementById('task-description')
  if (!textarea) return

  // Image paste handling — intercept clipboard images, save via extension backend
  textarea.addEventListener('paste', e => {
    const items = e.clipboardData?.items
    if (!items) return

    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault()
        const blob = item.getAsFile()
        if (!blob) continue

        const reader = new FileReader()
        reader.onload = () => {
          const base64 = reader.result.toString().split(',')[1]
          const ext = item.type === 'image/jpeg' ? 'jpg' : (item.type.split('/')[1] || 'png')
          vscode.postMessage({
            type: 'pasteImage',
            imageData: base64,
            mimeType: item.type,
            extension: ext
          })
        }
        reader.readAsDataURL(blob)
        break
      }
    }
  })
}

// =============================================
// Image Hover Preview Tooltip (VS Code-style)
// =============================================
let imageTooltip = null

function setupImageHoverPreview() {
  imageTooltip = document.createElement('div')
  imageTooltip.className = 'image-hover-tooltip'
  imageTooltip.style.display = 'none'
  document.body.appendChild(imageTooltip)

  // Show tooltip on hover over image trigger links
  document.addEventListener('mouseover', e => {
    const trigger = e.target.closest('.image-hover-trigger')
    if (trigger) {
      const src = trigger.dataset.src
      imageTooltip.innerHTML = `<img src="${src}" alt="Preview" />`
      imageTooltip.style.display = 'block'
      positionTooltip(trigger)
    }
  })

  // Hide tooltip when leaving trigger (but not when moving to tooltip itself)
  document.addEventListener('mouseout', e => {
    const trigger = e.target.closest('.image-hover-trigger')
    if (trigger && !trigger.contains(e.relatedTarget) && e.relatedTarget !== imageTooltip && !imageTooltip.contains(e.relatedTarget)) {
      imageTooltip.style.display = 'none'
    }
  })

  // Hide tooltip when leaving the tooltip itself
  imageTooltip.addEventListener('mouseleave', () => {
    imageTooltip.style.display = 'none'
  })
}

function positionTooltip(trigger) {
  const rect = trigger.getBoundingClientRect()
  const tooltipWidth = 400
  const tooltipMaxHeight = 300

  let left = rect.left
  let top = rect.bottom + 8

  // Keep within viewport
  if (left + tooltipWidth > window.innerWidth) {
    left = window.innerWidth - tooltipWidth - 16
  }
  if (top + tooltipMaxHeight > window.innerHeight) {
    top = rect.top - tooltipMaxHeight - 8
  }

  imageTooltip.style.left = `${Math.max(8, left)}px`
  imageTooltip.style.top = `${top}px`
}

// Filter and sort event listeners
document.addEventListener('DOMContentLoaded', () => {
  setupTagsInput()
  setupStepsInput()
  setupDescriptionHandlers()
  setupImageHoverPreview()

  // Tag filtering
  document.getElementById('tag-filter').addEventListener('input', e => {
    currentTagFilter = e.target.value
    renderBoard()
  })

  // Sorting
  document.getElementById('sort-select').addEventListener('change', e => {
    currentSort = e.target.value
    renderBoard()
  })

  // Clear filters
  document.getElementById('clear-filters').addEventListener('click', () => {
    document.getElementById('tag-filter').value = ''
    document.getElementById('sort-select').value = 'none'
    currentTagFilter = ''
    currentSort = 'none'
    renderBoard()
  })

  // Show filters (using event delegation for dynamically created button)
  document.addEventListener('click', e => {
    if (e.target && e.target.id === 'show-filters-dynamic') {
      toggleFilters(true)
    }
  })

  // Hide filters
  document.getElementById('hide-filters').addEventListener('click', () => {
    toggleFilters(false)
  })

  // Copy task ID on click (delegated)
  document.addEventListener('click', e => {
    const badge = e.target.closest('[data-copy-id]')
    if (badge) {
      copyTaskId(e, badge, badge.dataset.copyId)
    }
  })

  // Request board data on load (handles race condition when HTML is first set)
  vscode.postMessage({ type: 'requestBoard' })
})

// Form submission handling
document.getElementById('task-form').addEventListener('submit', e => {
  e.preventDefault()

  const taskData = {
    title: document.getElementById('task-title').value.trim(),
    description: document.getElementById('task-description').value.trim(),
    priority: document.getElementById('task-priority').value || undefined,
    workload: document.getElementById('task-workload').value || undefined,
    dueDate: document.getElementById('task-due-date').value || undefined,
    defaultExpanded: document.getElementById('task-default-expanded').checked,
    tags: getFormTags(),
    steps: getFormSteps()
  }

  if (!taskData.title) {
    alert('Please enter a task title')
    return
  }

  if (isEditMode) {
    vscode.postMessage({
      type: 'editTask',
      taskId: currentEditingTask,
      columnId: currentEditingColumn,
      taskData: taskData
    })
  } else {
    vscode.postMessage({
      type: 'addTask',
      columnId: currentEditingColumn,
      taskData: taskData
    })
  }

  closeTaskModal()
})

// Close modal when clicking outside
document.getElementById('task-modal').addEventListener('click', e => {
  if (e.target.id === 'task-modal') {
    closeTaskModal()
  }
})

// Close confirm modal when clicking outside
document.getElementById('confirm-modal').addEventListener('click', e => {
  if (e.target.id === 'confirm-modal') {
    closeConfirmModal()
  }
})

// Close input modal when clicking outside
document.getElementById('input-modal').addEventListener('click', e => {
  if (e.target.id === 'input-modal') {
    closeInputModal()
  }
})

// Close detail modal when clicking outside
document.getElementById('task-detail-modal').addEventListener('click', e => {
  if (e.target.id === 'task-detail-modal') {
    closeTaskDetailModal()
  }
})

// ESC key closes modals (topmost first)
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    const taskModal = document.getElementById('task-modal')
    const confirmModal = document.getElementById('confirm-modal')
    const inputModal = document.getElementById('input-modal')
    const detailModal = document.getElementById('task-detail-modal')

    if (confirmModal.style.display === 'block') {
      closeConfirmModal()
    } else if (inputModal.style.display === 'block') {
      closeInputModal()
    } else if (taskModal.style.display === 'block') {
      closeTaskModal()
    } else if (detailModal.style.display === 'block') {
      closeTaskDetailModal()
    }
  }
})
