import { useCallback, useEffect, useState } from 'react'
import type {
  AnalysisPayload,
  Course,
  CourseOccurrence,
  ExtractedCourse,
  ExtractedSchoolEvent,
  SchoolEvent,
  Semester
} from '../../../shared/types'
import { dateOfWeek, fmtWeekRanges, toDateStr, weekOfDate, weekdayCn } from '../../../shared/dateUtils'
import { Toast, useSubscribe, useToast, WEEKDAYS } from '../../shared/util'

interface Props {
  refreshKey: number
}

export function TimetablePage({ refreshKey }: Props): JSX.Element {
  const [semesters, setSemesters] = useState<Semester[]>([])
  const [activeSem, setActiveSem] = useState<Semester | null>(null)
  const [courses, setCourses] = useState<Course[]>([])
  const [overrides, setOverrides] = useState<Array<{ courseId: string; date: string; kind: 'cancel' | 'edit'; newStartTime?: string | null; newEndTime?: string | null; newLocation?: string | null }>>([])
  const [schoolEvents, setSchoolEvents] = useState<SchoolEvent[]>([])
  const [courseEditor, setCourseEditor] = useState<Course | 'new' | null>(null)
  const [overrideEditor, setOverrideEditor] = useState<Course | null>(null)
  const [semEditor, setSemEditor] = useState<Semester | 'new' | null>(null)
  const [importWizard, setImportWizard] = useState<null | 'timetable' | 'school-calendar'>(null)
  const [toast, showToast] = useToast()

  const reload = useCallback(async (): Promise<void> => {
    const sems = await window.api.listSemesters()
    setSemesters(sems)
    const today = toDateStr(new Date())
    const active = sems.find((s) => {
      const w = weekOfDate(s.startDate, today)
      return w >= 1 && w <= s.weeks
    })
    const sem = sems.find((s) => s.id === activeSem?.id) ?? active ?? sems[0] ?? null
    setActiveSem(sem)
    if (sem) {
      setCourses(await window.api.listCourses(sem.id))
      setSchoolEvents(await window.api.listSchoolEvents(sem.id))
      setOverrides(await window.api.listCourseOverrides())
    } else {
      setCourses([])
      setSchoolEvents([])
      setOverrides([])
    }
  }, [activeSem])

  useEffect(() => {
    void reload()
  }, [reload, refreshKey])

  useSubscribe('evt:data-changed', useCallback(() => void reload(), [reload]))

  const today = toDateStr(new Date())
  const currentWeek = activeSem ? weekOfDate(activeSem.startDate, today) : 0
  // 本周各天的课程
  const weekOccs: Record<number, CourseOccurrence[]> = { 1: [], 2: [], 3: [], 4: [], 5: [], 6: [], 7: [] }
  if (activeSem) {
    for (let wd = 1; wd <= 7; wd++) {
      const date = dateOfWeek(activeSem.startDate, currentWeek, wd)
      const ocs = courses
        .filter((c) => c.weekday === wd && inRanges(c.weeks, currentWeek))
        .map((c) => ({ course: c, date, startTime: c.startTime, endTime: c.endTime, location: c.location, cancelled: overrides.some((o) => o.courseId === c.id && o.date === date && o.kind === 'cancel') }))
      weekOccs[wd] = ocs
    }
  }

  return (
    <div className="page" style={{ flexDirection: 'column' }}>
      <div className="row" style={{ marginBottom: 8 }}>
        <h3 style={{ margin: 0 }}>🎓 课表与校历</h3>
        <select
          value={activeSem?.id ?? ''}
          onChange={(e) => {
            const s = semesters.find((x) => x.id === e.target.value) ?? null
            setActiveSem(s)
          }}
        >
          {semesters.length === 0 && <option value="">未设置学期</option>}
          {semesters.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        {activeSem && (
          <span className="muted">
            开学 {activeSem.startDate} · 第 {currentWeek} 教学周 / 共 {activeSem.weeks} 周
          </span>
        )}
        <div className="spacer" />
        <button onClick={() => setSemEditor('new')}>学期设置</button>
        <button onClick={() => setImportWizard('timetable')}>导入课表</button>
        <button onClick={() => setImportWizard('school-calendar')}>导入校历</button>
        <button className="primary" onClick={() => setCourseEditor('new')} disabled={!activeSem}>
          + 添加课程
        </button>
      </div>

      {!activeSem && (
        <div className="card" style={{ flex: 1 }}>
          <div className="empty">
            先设置学期(开学日期 = 第一教学周周一),再把课表图片/文件通过"导入课表"交给 AI 提取。
          </div>
        </div>
      )}

      {activeSem && (
        <div style={{ display: 'flex', gap: 14, flex: 1, minHeight: 0 }}>
          <div className="week-grid" style={{ flex: 1 }}>
            {[1, 2, 3, 4, 5, 6, 7].map((wd) => (
              <div key={wd} className="week-col">
                <div className="day-name">
                  {WEEKDAYS[wd - 1]}
                  {currentWeek >= 1 && currentWeek <= activeSem.weeks && dateOfWeek(activeSem.startDate, currentWeek, wd) === today && ' (今天)'}
                </div>
                {weekOccs[wd].length === 0 && <div className="muted" style={{ textAlign: 'center' }}>—</div>}
                {weekOccs[wd].map((o, i) => (
                  <div
                    key={i}
                    className={`course-block ${o.cancelled ? 'cancelled' : ''}`}
                    onClick={() => setOverrideEditor(o.course)}
                    title="点击可设置该课的临时停课/调课"
                  >
                    <b>{o.course.name}</b>
                    <span className="loc">
                      {o.startTime}-{o.endTime} {o.location ? `@${o.location}` : ''}
                    </span>
                    <span className="loc">{fmtWeekRanges(o.course.weeks)}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>

          <div className="card" style={{ width: 280, flexShrink: 0 }}>
            <h3>校历要点</h3>
            {schoolEvents.length === 0 && <div className="muted">暂无校历信息,可通过"导入校历"提取</div>}
            {schoolEvents.map((s) => (
              <div key={s.id} className="list-row">
                <div style={{ flex: 1 }}>
                  <span className="chip school">{schoolLabel(s.type)}</span> {s.title}
                  <div className="muted">
                    {s.startDate}
                    {s.endDate ? ` ~ ${s.endDate}` : ''}
                    {s.note ? ` · ${s.note}` : ''}
                  </div>
                </div>
                <button
                  className="ghost danger"
                  onClick={async () => {
                    await window.api.deleteSchoolEvent(s.id)
                    void reload()
                  }}
                >
                  删
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 学期编辑 */}
      {semEditor && (
        <SemesterEditor
          initial={semEditor === 'new' ? null : activeSem}
          onClose={() => setSemEditor(null)}
          onSaved={async () => {
            setSemEditor(null)
            await reload()
          }}
        />
      )}

      {/* 课程编辑 */}
      {courseEditor && activeSem && (
        <CourseEditor
          semesterId={activeSem.id}
          initial={courseEditor === 'new' ? null : courseEditor}
          onClose={() => setCourseEditor(null)}
          onSaved={async () => {
            setCourseEditor(null)
            await reload()
          }}
        />
      )}

      {/* 临时调整 */}
      {overrideEditor && activeSem && (
        <OverrideEditor
          course={overrideEditor}
          onClose={() => setOverrideEditor(null)}
          onSaved={async () => {
            setOverrideEditor(null)
            showToast('已记录,对应日期将按调整显示')
          }}
        />
      )}

      {/* 导入向导 */}
      {importWizard && activeSem && (
        <ImportWizard
          kind={importWizard}
          semester={activeSem}
          onClose={() => setImportWizard(null)}
          onDone={async (msg) => {
            setImportWizard(null)
            showToast(msg)
            await reload()
          }}
        />
      )}
      <Toast text={toast} />
    </div>
  )
}

function inRanges(ranges: Array<[number, number]>, week: number): boolean {
  return ranges.some(([s, e]) => week >= s && week <= e)
}

function schoolLabel(t: string): string {
  return { holiday: '假期', exam: '考试', registration: '报到', adjust: '调课', other: '校历' }[t] ?? '校历'
}

// ---------- 学期编辑 ----------

function SemesterEditor({
  initial,
  onClose,
  onSaved
}: {
  initial: Semester | null
  onClose: () => void
  onSaved: () => Promise<void>
}): JSX.Element {
  const [name, setName] = useState(initial?.name ?? `2026-2027-${initial ? '' : '1'}`)
  const [startDate, setStartDate] = useState(initial?.startDate ?? '')
  const [weeks, setWeeks] = useState(initial?.weeks ?? 20)

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{initial ? '编辑学期' : '新建学期'}</h3>
        <div className="form-grid">
          <label>学期名称</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="如 2026-2027-1" />
          <label>开学日期</label>
          <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          <label>总周数</label>
          <input type="number" value={weeks} onChange={(e) => setWeeks(Number(e.target.value))} />
        </div>
        <div className="muted">开学日期必须是第一教学周的周一(校历导入后可自动回填)。</div>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button onClick={onClose}>取消</button>
          <button
            className="primary"
            onClick={async () => {
              if (!name.trim() || !startDate) return
              await window.api.saveSemester({ id: initial?.id, name: name.trim(), startDate, weeks })
              await onSaved()
            }}
          >
            保存
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------- 课程编辑 ----------

function CourseEditor({
  semesterId,
  initial,
  onClose,
  onSaved
}: {
  semesterId: string
  initial: Course | null
  onClose: () => void
  onSaved: () => Promise<void>
}): JSX.Element {
  const [name, setName] = useState(initial?.name ?? '')
  const [weekday, setWeekday] = useState(initial?.weekday ?? 1)
  const [start, setStart] = useState(initial?.startTime ?? '08:00')
  const [end, setEnd] = useState(initial?.endTime ?? '09:25')
  const [weeksText, setWeeksText] = useState(
    initial ? initial.weeks.map(([s, e]) => (s === e ? String(s) : `${s}-${e}`)).join(',') : '1-17'
  )
  const [location, setLocation] = useState(initial?.location ?? '')
  const [teacher, setTeacher] = useState(initial?.teacher ?? '')

  const submit = async (): Promise<void> => {
    const weeks = parseWeeks(weeksText)
    await window.api.saveCourse({
      id: initial?.id,
      semesterId,
      name: name.trim(),
      weekday,
      startTime: start,
      endTime: end,
      weeks,
      location: location || null,
      teacher: teacher || null
    })
    await onSaved()
  }

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{initial ? '编辑课程' : '添加课程'}</h3>
        <div className="form-grid">
          <label>课程名</label>
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          <label>星期</label>
          <select value={weekday} onChange={(e) => setWeekday(Number(e.target.value))}>
            {WEEKDAYS.map((d, i) => (
              <option key={d} value={i + 1}>
                {d}
              </option>
            ))}
          </select>
          <label>开始</label>
          <input type="time" value={start} onChange={(e) => setStart(e.target.value)} />
          <label>结束</label>
          <input type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
          <label>教学周</label>
          <input value={weeksText} onChange={(e) => setWeeksText(e.target.value)} placeholder="如 1-6,8-17 或 10-13" />
          <label>教室</label>
          <input value={location} onChange={(e) => setLocation(e.target.value)} />
          <label>教师</label>
          <input value={teacher} onChange={(e) => setTeacher(e.target.value)} />
        </div>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button onClick={onClose}>取消</button>
          <button className="primary" onClick={() => void submit()}>
            保存
          </button>
        </div>
      </div>
    </div>
  )
}

export function parseWeeks(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = []
  for (const part of text.split(/[,，、\s]+/).filter(Boolean)) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part)
    if (m) out.push([Number(m[1]), Number(m[2] ?? m[1])])
  }
  return out.length > 0 ? out : [[1, 17]]
}

// ---------- 临时调整 ----------

function OverrideEditor({
  course,
  onClose,
  onSaved
}: {
  course: Course
  onClose: () => void
  onSaved: () => Promise<void>
}): JSX.Element {
  const [kind, setKind] = useState<'cancel' | 'edit'>('cancel')
  const [date, setDate] = useState(toDateStr(new Date()))
  const [newStart, setNewStart] = useState(course.startTime)
  const [newEnd, setNewEnd] = useState(course.endTime)
  const [newLoc, setNewLoc] = useState(course.location ?? '')

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>临时调整:{course.name}</h3>
        <div className="form-grid">
          <label>日期</label>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          <label>类型</label>
          <select value={kind} onChange={(e) => setKind(e.target.value as 'cancel' | 'edit')}>
            <option value="cancel">当次停课</option>
            <option value="edit">当次调课/换教室</option>
          </select>
          {kind === 'edit' && (
            <>
              <label>新开始</label>
              <input type="time" value={newStart} onChange={(e) => setNewStart(e.target.value)} />
              <label>新结束</label>
              <input type="time" value={newEnd} onChange={(e) => setNewEnd(e.target.value)} />
              <label>新教室</label>
              <input value={newLoc} onChange={(e) => setNewLoc(e.target.value)} />
            </>
          )}
        </div>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button onClick={onClose}>取消</button>
          <button
            className="primary"
            onClick={async () => {
              await window.api.saveCourseOverride({
                courseId: course.id,
                date,
                kind,
                newStartTime: kind === 'edit' ? newStart : null,
                newEndTime: kind === 'edit' ? newEnd : null,
                newLocation: kind === 'edit' ? newLoc || null : null
              })
              await onSaved()
            }}
          >
            保存
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------- 导入向导 ----------

function ImportWizard({
  kind,
  semester,
  onClose,
  onDone
}: {
  kind: 'timetable' | 'school-calendar'
  semester: Semester
  onClose: () => void
  onDone: (msg: string) => Promise<void>
}): JSX.Element {
  const [paths, setPaths] = useState<string[]>([])
  const [text, setText] = useState('')
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')
  const [payload, setPayload] = useState<AnalysisPayload | null>(null)
  const [startDate, setStartDate] = useState(semester.startDate)
  const [weeks, setWeeks] = useState(semester.weeks)
  const [courses, setCourses] = useState<ExtractedCourse[]>([])
  const [events, setEvents] = useState<ExtractedSchoolEvent[]>([])
  const [existingCourses, setExistingCourses] = useState<Course[]>([])
  const [hover, setHover] = useState(false)

  useEffect(() => {
    void window.api.listCourses(semester.id).then(setExistingCourses)
  }, [semester.id])

  const run = async (): Promise<void> => {
    setRunning(true)
    setError('')
    try {
      const input = { texts: text.trim() ? [{ name: '粘贴内容', content: text }] : [], files: paths }
      const result =
        kind === 'timetable'
          ? await window.api.importTimetable(input)
          : await window.api.importSchoolCalendar(input)
      const p = (result.payload ?? {}) as AnalysisPayload
      setPayload(p)
      setCourses(p.courses ?? [])
      setEvents(p.schoolEvents ?? [])
      if (p.semester?.startDate) setStartDate(p.semester.startDate)
      if (p.semester?.weeks) setWeeks(p.semester.weeks)
      if (!p.courses && !p.schoolEvents) setError('没有提取到内容' + (p.questions ? ':' + p.questions.join(';') : ''))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRunning(false)
    }
  }

  const confirmTimetable = async (): Promise<void> => {
    await window.api.saveSemester({ id: semester.id, name: semester.name, startDate, weeks })
    let added = 0
    let skipped = 0
    for (const c of courses) {
      const dup = existingCourses.some((e) => e.name === c.name && e.weekday === c.weekday && e.startTime === c.startTime)
      if (dup) {
        skipped++
        continue
      }
      await window.api.saveCourse({
        semesterId: semester.id,
        name: c.name,
        weekday: c.weekday,
        startTime: c.startTime,
        endTime: c.endTime,
        weeks: c.weeks,
        location: c.location ?? null,
        teacher: c.teacher ?? null
      })
      added++
    }
    const qs = payload?.questions?.length ? `(待确认:${payload.questions.join(';')})` : ''
    await onDone(`已导入 ${added} 门课程${skipped ? `,跳过重复 ${skipped} 门` : ''}${qs}`)
  }

  const confirmCalendar = async (): Promise<void> => {
    let added = 0
    for (const e of events) {
      await window.api.saveSchoolEvent({
        semesterId: semester.id,
        type: e.type,
        title: e.title,
        startDate: e.startDate,
        endDate: e.endDate ?? null,
        note: e.note ?? null
      })
      added++
    }
    await onDone(`已导入 ${added} 条校历信息`)
  }

  const preview = payload && (courses.length > 0 || events.length > 0)

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <h3>{kind === 'timetable' ? '导入课表' : '导入校历'}</h3>
        {!payload && (
          <>
            <div
              className={`dropzone ${hover ? 'hover' : ''}`}
              onDragOver={(e) => {
                e.preventDefault()
                setHover(true)
              }}
              onDragLeave={() => setHover(false)}
              onDrop={(e) => {
                e.preventDefault()
                setHover(false)
                const list: string[] = []
                for (const f of Array.from(e.dataTransfer.files)) {
                  const p = window.api.pathForFile(f)
                  if (p) list.push(p)
                }
                setPaths(list)
              }}
              onClick={() => {
                const input = document.createElement('input')
                input.type = 'file'
                input.multiple = true
                input.onchange = () => {
                  if (input.files) {
                    setPaths(Array.from(input.files).map((f) => window.api.pathForFile(f)))
                  }
                }
                input.click()
              }}
            >
              把课表图片 / PDF / 文本文件拖到这里,或点击选择文件
              {paths.length > 0 && <div style={{ marginTop: 6, color: 'var(--accent)' }}>已选择 {paths.length} 个文件</div>}
            </div>
            <textarea
              rows={4}
              placeholder="也可以直接粘贴课表/校历文本"
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            {error && <div className="muted" style={{ color: 'var(--danger)' }}>{error}</div>}
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button onClick={onClose}>取消</button>
              <button className="primary" disabled={running || (paths.length === 0 && !text.trim())} onClick={() => void run()}>
                {running ? 'AI 提取中…' : '开始提取'}
              </button>
            </div>
          </>
        )}
        {payload && !preview && (
          <>
            <div className="muted">{error || '模型没有提取到可导入的内容'}</div>
            {payload.questions && payload.questions.length > 0 && (
              <div>
                {payload.questions.map((q, i) => (
                  <div key={i} className="muted">
                    ❓ {q}
                  </div>
                ))}
              </div>
            )}
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button onClick={onClose}>关闭</button>
            </div>
          </>
        )}
        {preview && kind === 'timetable' && (
          <>
            <div className="form-grid">
              <label>开学日期</label>
              <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
              <label>总周数</label>
              <input type="number" value={weeks} onChange={(e) => setWeeks(Number(e.target.value))} />
            </div>
            {!startDate && <div className="muted" style={{ color: 'var(--danger)' }}>材料中没有开学日期,请先填写第一教学周的周一,否则课程无法对应到具体日期。</div>}
            <div className="card" style={{ maxHeight: 300, padding: 8 }}>
              <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th>课程</th>
                    <th>星期</th>
                    <th>时间</th>
                    <th>教学周</th>
                    <th>教室</th>
                  </tr>
                </thead>
                <tbody>
                  {courses.map((c, i) => (
                    <tr key={i}>
                      <td>{c.name}</td>
                      <td>{weekdayCn(c.weekday)}</td>
                      <td>
                        {c.startTime}-{c.endTime}
                      </td>
                      <td>{fmtWeekRanges(c.weeks)}</td>
                      <td>{c.location ?? '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {payload?.questions && payload.questions.length > 0 && (
              <div>
                {payload.questions.map((q, i) => (
                  <div key={i} className="muted">
                    ❓ {q}
                  </div>
                ))}
              </div>
            )}
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button onClick={onClose}>取消</button>
              <button className="primary" disabled={!startDate} onClick={() => void confirmTimetable()}>
                确认导入 {courses.length} 门课程
              </button>
            </div>
          </>
        )}
        {preview && kind === 'school-calendar' && (
          <>
            <div className="form-grid">
              <label>开学日期</label>
              <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
              <label>总周数</label>
              <input type="number" value={weeks} onChange={(e) => setWeeks(Number(e.target.value))} />
            </div>
            <div className="card" style={{ maxHeight: 300, padding: 8 }}>
              {events.map((e, i) => (
                <div key={i} className="list-row">
                  <span className="chip school">{schoolLabel(e.type)}</span>
                  <span style={{ flex: 1 }}>
                    {e.title}({e.startDate}
                    {e.endDate ? ` ~ ${e.endDate}` : ''})
                  </span>
                </div>
              ))}
            </div>
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button onClick={onClose}>取消</button>
              <button className="primary" onClick={() => void confirmCalendar()}>
                确认导入 {events.length} 条校历信息
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
