/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { DateTimeValue, getParserManager } from '@nextcloud/calendar-js'
import { showWarning } from '@nextcloud/dialogs'
import { translate } from '@nextcloud/l10n'
import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it, vi } from 'vitest'
import { mapAlarmComponentToAlarmObject } from '@/models/alarm.js'
import { copyCalendarObjectInstanceIntoEventComponent, mapEventComponentToEventObject } from '@/models/event.js'
import { updateRoomParticipantsFromEvent } from '@/services/talkService'
import getTimezoneManager from '@/services/timezoneDataProviderService.js'
import useCalendarObjectInstanceStore from '@/store/calendarObjectInstance.js'
import useCalendarObjectsStore from '@/store/calendarObjects.js'
import { getObjectAtRecurrenceId } from '@/utils/calendarObject.js'

vi.mock('@/models/alarm.js')
vi.mock('@/models/event.js')
vi.mock('@/services/talkService')
vi.mock('@/utils/calendarObject.js')
vi.mock('@nextcloud/dialogs')
vi.mock('@nextcloud/l10n')

const mockedMapAlarmComponentToAlarmObject = vi.mocked(mapAlarmComponentToAlarmObject)
const mockedCopyCalendarObjectInstanceIntoEventComponent = vi.mocked(copyCalendarObjectInstanceIntoEventComponent)
const mockedMapEventComponentToEventObject = vi.mocked(mapEventComponentToEventObject)
const mockedGetObjectAtRecurrenceId = vi.mocked(getObjectAtRecurrenceId)

/**
 * Builds a minimal fake DateTimeValue-like object, just enough for the
 * comparison/arithmetic the store performs when deciding whether an
 * occurrence's date/time was changed, plus the date-component getters
 * getDateFromDateTimeValue() reads when reverting a discarded change.
 *
 * @param time Point in time, treated as unix seconds (UTC)
 */
function fakeDateTime(time: number) {
	return {
		time,
		get year() {
			return new Date(this.time * 1000).getFullYear()
		},
		get month() {
			return new Date(this.time * 1000).getMonth() + 1
		},
		get day() {
			return new Date(this.time * 1000).getDate()
		},
		get hour() {
			return new Date(this.time * 1000).getHours()
		},
		get minute() {
			return new Date(this.time * 1000).getMinutes()
		},
		compare(other: { time: number }) {
			if (this.time === other.time) {
				return 0
			}
			return this.time < other.time ? -1 : 1
		},
		clone() {
			return fakeDateTime(this.time)
		},
		addDuration(duration: { seconds: number }) {
			this.time += duration.seconds
		},
		subtractDateWithTimezone(other: { time: number }) {
			return fakeDuration(this.time - other.time)
		},
	}
}

/**
 * Builds a minimal fake DurationValue-like object, just enough for the
 * length comparison the store performs when deciding whether an
 * occurrence's duration was changed.
 *
 * @param seconds Length of the duration, in arbitrary units
 */
function fakeDuration(seconds: number) {
	return {
		seconds,
		compare(other: { seconds: number }) {
			if (this.seconds === other.seconds) {
				return 0
			}
			return this.seconds < other.seconds ? -1 : 1
		},
	}
}

describe('store/calendarObjectInstance test suite', () => {
	beforeEach(() => {
		setActivePinia(createPinia())

		mockedMapAlarmComponentToAlarmObject.mockReset()
		mockedCopyCalendarObjectInstanceIntoEventComponent.mockReset()
		mockedMapEventComponentToEventObject.mockReset().mockReturnValue({ eventComponent: {} })
		mockedGetObjectAtRecurrenceId.mockReset().mockReturnValue({})
		vi.mocked(showWarning).mockClear()
		vi.mocked(translate).mockClear().mockReturnValue('translated warning')
		vi.mocked(updateRoomParticipantsFromEvent).mockClear()
	})

	describe('duplicateCalendarObjectInstance', () => {
		/**
		 * @param store The calendarObjectInstance store
		 * @param calendarId The id of the calendar the source event lives in
		 */
		function setUpSourceEvent(store: ReturnType<typeof useCalendarObjectInstanceStore>, calendarId: string) {
			store.calendarObject = { calendarId }
			store.calendarObjectInstance = {
				eventComponent: {
					startDate: {
						timezoneId: 'UTC',
						getInUTC: () => ({ unixTime: 1000, jsDate: new Date(1000 * 1000) }),
					},
					endDate: {
						getInUTC: () => ({ unixTime: 2000 }),
					},
					isAllDay: () => false,
				},
			}
		}

		it('duplicates into the explicitly given calendar instead of the source calendar', async () => {
			const store = useCalendarObjectInstanceStore()
			const calendarObjectsStore = useCalendarObjectsStore()
			setUpSourceEvent(store, 'readonly-calendar')
			vi.spyOn(calendarObjectsStore, 'createNewEvent').mockResolvedValue({ calendarComponent: {} })

			await store.duplicateCalendarObjectInstance({ calendarId: 'writable-calendar' })

			expect(calendarObjectsStore.createNewEvent).toHaveBeenCalledWith(expect.objectContaining({ calendarId: 'writable-calendar' }))
		})

		it('marks the duplicated event as a new, unsaved calendar-object', async () => {
			const store = useCalendarObjectInstanceStore()
			const calendarObjectsStore = useCalendarObjectsStore()
			setUpSourceEvent(store, 'source-calendar')
			const newCalendarObject = { calendarComponent: {} }
			vi.spyOn(calendarObjectsStore, 'createNewEvent').mockResolvedValue(newCalendarObject)

			await store.duplicateCalendarObjectInstance({ calendarId: 'writable-calendar' })

			expect(store.isNew).toBe(true)
			expect(store.calendarObject).toStrictEqual(newCalendarObject)
		})
	})

	describe('addAlarmToCalendarObjectInstance', () => {
		it('adds the alarm to an explicitly given calendar-object-instance instead of the store state', () => {
			const store = useCalendarObjectInstanceStore()
			// No event is currently loaded into the store, e.g. when creating the very first event of a session
			store.calendarObjectInstance = null

			const alarmComponent = { addProperty: vi.fn(), toICALJs: vi.fn().mockReturnValue({ toString: () => '' }) }
			const eventComponent = { addRelativeAlarm: vi.fn().mockReturnValue(alarmComponent) }
			const calendarObjectInstance = { eventComponent, alarms: [] }
			const alarmObject = { alarmComponent }
			mockedMapAlarmComponentToAlarmObject.mockReturnValue(alarmObject)

			expect(() => store.addAlarmToCalendarObjectInstance({
				calendarObjectInstance,
				type: 'DISPLAY',
				totalSeconds: -600,
			})).not.toThrow()

			expect(calendarObjectInstance.alarms).toContain(alarmObject)
		})

		it('falls back to the calendar-object-instance in the store when none is given', () => {
			const store = useCalendarObjectInstanceStore()
			const alarmComponent = { addProperty: vi.fn(), toICALJs: vi.fn().mockReturnValue({ toString: () => '' }) }
			const eventComponent = { addRelativeAlarm: vi.fn().mockReturnValue(alarmComponent) }
			store.calendarObjectInstance = { eventComponent, alarms: [] }
			const alarmObject = { alarmComponent }
			mockedMapAlarmComponentToAlarmObject.mockReturnValue(alarmObject)

			store.addAlarmToCalendarObjectInstance({
				type: 'DISPLAY',
				totalSeconds: -600,
			})

			expect(store.calendarObjectInstance.alarms).toContainEqual(alarmObject)
		})
	})

	describe('removeAlarmFromCalendarObjectInstance', () => {
		it('removes the alarm from an explicitly given calendar-object-instance instead of the store state', () => {
			const store = useCalendarObjectInstanceStore()
			// No event is currently loaded into the store, e.g. when creating the very first event of a session
			store.calendarObjectInstance = null

			const matchedAlarmComponent = { trigger: { value: { totalSeconds: -600 } }, action: 'DISPLAY' }
			const eventComponent = {
				getAlarmIterator: () => [matchedAlarmComponent],
				removeAlarm: vi.fn(),
			}
			const alarm = { alarmComponent: matchedAlarmComponent }
			const calendarObjectInstance = { eventComponent, alarms: [alarm] }

			expect(() => store.removeAlarmFromCalendarObjectInstance({
				calendarObjectInstance,
				alarm,
			})).not.toThrow()

			expect(eventComponent.removeAlarm).toHaveBeenCalledWith(matchedAlarmComponent)
			expect(calendarObjectInstance.alarms).not.toContain(alarm)
		})
	})

	describe('saveAttendeeParticipationResponse', () => {
		it('updates the recurring master when responding to a generated occurrence', async () => {
			const store = useCalendarObjectInstanceStore()
			const calendarObjectsStore = useCalendarObjectsStore()
			const masterAttendee = {
				email: 'attendee@example.com',
				participationStatus: 'NEEDS-ACTION',
			}
			const masterComponent = {
				name: 'VEVENT',
				hasProperty: vi.fn().mockReturnValue(false),
				getAttendeeIterator: vi.fn().mockReturnValue([masterAttendee]),
			}
			const occurrenceAttendee = {
				email: 'ATTENDEE@example.com',
				participationStatus: 'NEEDS-ACTION',
			}
			const eventComponent = {
				name: 'VEVENT',
				isRecurrenceException: vi.fn().mockReturnValue(false),
			}
			const attendee = {
				attendeeProperty: occurrenceAttendee,
				participationStatus: 'NEEDS-ACTION',
			}
			const calendarObject = {
				calendarComponent: {
					getComponentIterator: vi.fn().mockReturnValue([masterComponent]),
				},
			}
			store.calendarObject = calendarObject
			store.calendarObjectInstance = { eventComponent }
			vi.spyOn(calendarObjectsStore, 'updateCalendarObject').mockResolvedValue()

			await store.saveAttendeeParticipationResponse({
				attendee,
				participationStatus: 'ACCEPTED',
			})

			expect(masterAttendee.participationStatus).toBe('ACCEPTED')
			expect(occurrenceAttendee.participationStatus).toBe('NEEDS-ACTION')
			expect(attendee.participationStatus).toBe('ACCEPTED')
			expect(calendarObjectsStore.updateCalendarObject).toHaveBeenCalledWith({ calendarObject })
		})

		it('updates an existing recurrence exception without changing the master', async () => {
			const store = useCalendarObjectInstanceStore()
			const calendarObjectsStore = useCalendarObjectsStore()
			const masterAttendee = {
				email: 'attendee@example.com',
				participationStatus: 'ACCEPTED',
			}
			const exceptionAttendee = {
				email: 'attendee@example.com',
				participationStatus: 'NEEDS-ACTION',
			}
			const eventComponent = {
				name: 'VEVENT',
				isRecurrenceException: vi.fn().mockReturnValue(true),
			}
			const attendee = {
				attendeeProperty: exceptionAttendee,
				participationStatus: 'NEEDS-ACTION',
			}
			const calendarObject = {
				calendarComponent: {
					getComponentIterator: vi.fn().mockReturnValue([{
						name: 'VEVENT',
						getAttendeeIterator: vi.fn().mockReturnValue([masterAttendee]),
					}]),
				},
			}
			store.calendarObject = calendarObject
			store.calendarObjectInstance = { eventComponent }
			vi.spyOn(calendarObjectsStore, 'updateCalendarObject').mockResolvedValue()

			await store.saveAttendeeParticipationResponse({
				attendee,
				participationStatus: 'DECLINED',
			})

			expect(exceptionAttendee.participationStatus).toBe('DECLINED')
			expect(masterAttendee.participationStatus).toBe('ACCEPTED')
			expect(attendee.participationStatus).toBe('DECLINED')
			expect(calendarObject.calendarComponent.getComponentIterator).not.toHaveBeenCalled()
			expect(calendarObjectsStore.updateCalendarObject).toHaveBeenCalledWith({ calendarObject })
		})
	})

	describe('saveCalendarObjectInstance', () => {
		/**
		 * @param baseStart Base component's own DTSTART. This is not necessarily a real
		 *                  occurrence - e.g. it may not match the RRULE's BYDAY - so it must
		 *                  not be used directly to identify the first occurrence.
		 * @param baseEnd Base component's own DTEND
		 * @param firstOccurrenceRecurrenceId Recurrence-id of the first occurrence the
		 *                                    recurrence-manager actually generates. Defaults
		 *                                    to baseStart for a series whose DTSTART lines up
		 *                                    with its own recurrence rule.
		 */
		function setUpBaseComponent(baseStart: number, baseEnd: number, firstOccurrenceRecurrenceId: number = baseStart) {
			const baseProperty = {
				name: 'SUMMARY',
			}
			return {
				name: 'VEVENT',
				hasProperty: vi.fn().mockReturnValue(false),
				getPropertyIterator: vi.fn().mockReturnValue([baseProperty]),
				deleteAllProperties: vi.fn(),
				addProperty: vi.fn(),
				deleteAllComponents: vi.fn(),
				addComponent: vi.fn(),
				startDate: fakeDateTime(baseStart),
				endDate: fakeDateTime(baseEnd),
				recurrenceManager: {
					getClosestOccurrence: vi.fn().mockReturnValue({
						getReferenceRecurrenceId: () => fakeDateTime(firstOccurrenceRecurrenceId),
					}),
					// Overridden per-test via mockReturnValue() where the non-primary-occurrence
					// branch needs to look up the actual, unedited occurrence.
					getOccurrenceAtExactly: vi.fn(),
				},
			}
		}

		/**
		 * @param originalRecurrenceId The occurrence's original (pre-edit) recurrence-id, or null when not forked
		 * @param start The occurrence's current (possibly edited) start time
		 * @param end The occurrence's current (possibly edited) end time
		 */
		function setUpEventComponent(originalRecurrenceId: number | null, start: number, end: number) {
			const exceptionPropertyClone = {}
			const exceptionProperty = {
				name: 'SUMMARY',
				clone: vi.fn().mockReturnValue(exceptionPropertyClone),
			}
			return {
				name: 'VEVENT',
				primaryItem: {},
				isDirty: vi.fn().mockReturnValue(true),
				isPartOfRecurrenceSet: vi.fn().mockReturnValue(true),
				getPropertyIterator: vi.fn().mockReturnValue([exceptionProperty]),
				getAlarmIterator: vi.fn().mockReturnValue([]),
				resetDirty: vi.fn(),
				originalRecurrenceId: originalRecurrenceId === null ? null : fakeDateTime(originalRecurrenceId),
				startDate: fakeDateTime(start),
				endDate: fakeDateTime(end),
			}
		}

		it('updates the recurring base component when saving the series from an unmoved exception', async () => {
			const store = useCalendarObjectInstanceStore()
			const calendarObjectsStore = useCalendarObjectsStore()
			const baseComponent = setUpBaseComponent(1000, 2000)
			// Same recurrence-id it was forked at, and the date/time weren't touched
			const exceptionComponent = setUpEventComponent(5000, 5000, 6000)
			const calendarObject = {
				calendarId: 'calendar-1',
				calendarComponent: {
					getComponentIterator: vi.fn().mockReturnValue([baseComponent, exceptionComponent]),
				},
			}
			store.calendarObject = calendarObject
			store.calendarObjectInstance = { eventComponent: exceptionComponent }
			vi.spyOn(calendarObjectsStore, 'updateCalendarObject').mockResolvedValue()
			// The real, unedited occurrence - same position/length as the (unchanged) exception
			baseComponent.recurrenceManager.getOccurrenceAtExactly.mockReturnValue({ startDate: fakeDateTime(5000), endDate: fakeDateTime(6000) })

			await store.saveCalendarObjectInstance({
				scope: 'series',
				calendarId: 'calendar-1',
			})

			expect(baseComponent.deleteAllProperties).toHaveBeenCalledWith('SUMMARY')
			expect(baseComponent.addProperty).toHaveBeenCalledWith(expect.anything())
			expect(baseComponent.startDate.time).toBe(1000)
			expect(baseComponent.endDate.time).toBe(2000)
			expect(showWarning).not.toHaveBeenCalled()
			expect(calendarObjectsStore.updateCalendarObject).toHaveBeenCalledWith({ calendarObject })
			expect(exceptionComponent.resetDirty).toHaveBeenCalled()
			expect(updateRoomParticipantsFromEvent).toHaveBeenCalledWith(exceptionComponent)
		})

		it('copies a property onto the base component even when the base component never had it before', async () => {
			const store = useCalendarObjectInstanceStore()
			const calendarObjectsStore = useCalendarObjectsStore()
			// The base component has no LOCATION property at all yet
			const baseComponent = setUpBaseComponent(1000, 2000)
			const locationPropertyClone = { marker: 'location-clone' }
			const locationProperty = {
				name: 'LOCATION',
				clone: vi.fn().mockReturnValue(locationPropertyClone),
			}
			const primaryOccurrence = setUpEventComponent(1000, 1000, 2000)
			// The user just added a location for the first time
			primaryOccurrence.getPropertyIterator = vi.fn().mockReturnValue([...primaryOccurrence.getPropertyIterator(), locationProperty])
			const calendarObject = {
				calendarId: 'calendar-1',
				calendarComponent: {
					getComponentIterator: vi.fn().mockReturnValue([baseComponent, primaryOccurrence]),
				},
			}
			store.calendarObject = calendarObject
			store.calendarObjectInstance = { eventComponent: primaryOccurrence }
			vi.spyOn(calendarObjectsStore, 'updateCalendarObject').mockResolvedValue()

			await store.saveCalendarObjectInstance({
				scope: 'series',
				calendarId: 'calendar-1',
			})

			expect(baseComponent.addProperty).toHaveBeenCalledWith(locationPropertyClone)
		})

		it('resets the dirty state of the throwaway fork after a successful series save, so closing the editor does not prompt to discard changes', async () => {
			const store = useCalendarObjectInstanceStore()
			const calendarObjectsStore = useCalendarObjectsStore()
			const baseComponent = setUpBaseComponent(1000, 2000)
			const primaryOccurrence = setUpEventComponent(1000, 1500, 2500)
			const calendarObject = {
				calendarId: 'calendar-1',
				calendarComponent: {
					getComponentIterator: vi.fn().mockReturnValue([baseComponent, primaryOccurrence]),
				},
			}
			store.calendarObject = calendarObject
			store.calendarObjectInstance = { eventComponent: primaryOccurrence }
			vi.spyOn(calendarObjectsStore, 'updateCalendarObject').mockResolvedValue()

			await store.saveCalendarObjectInstance({
				scope: 'series',
				calendarId: 'calendar-1',
			})

			// eventComponent is a throwaway fork never added to the calendar-object's
			// component tree, so calendarComponent.toICS() never undirtifies it on its own
			expect(primaryOccurrence.resetDirty).toHaveBeenCalled()
		})

		it('applies the date/time change when editing the primary occurrence of the series', async () => {
			const store = useCalendarObjectInstanceStore()
			const calendarObjectsStore = useCalendarObjectsStore()
			const baseComponent = setUpBaseComponent(1000, 2000)
			// Forked at the base component's own date, and then moved
			const primaryOccurrence = setUpEventComponent(1000, 1500, 2500)
			const calendarObject = {
				calendarId: 'calendar-1',
				calendarComponent: {
					getComponentIterator: vi.fn().mockReturnValue([baseComponent, primaryOccurrence]),
				},
			}
			store.calendarObject = calendarObject
			store.calendarObjectInstance = { eventComponent: primaryOccurrence }
			vi.spyOn(calendarObjectsStore, 'updateCalendarObject').mockResolvedValue()

			await store.saveCalendarObjectInstance({
				scope: 'series',
				calendarId: 'calendar-1',
			})

			expect(baseComponent.startDate.time).toBe(1500)
			expect(baseComponent.endDate.time).toBe(2500)
			expect(showWarning).not.toHaveBeenCalled()
		})

		it('applies the date/time change when DTSTART does not match the recurrence rule (e.g. RRULE BYDAY excludes it)', async () => {
			const store = useCalendarObjectInstanceStore()
			const calendarObjectsStore = useCalendarObjectsStore()
			// DTSTART (1000) is not a real occurrence of the series - the first one the
			// recurrence-manager actually generates is at 5000
			const baseComponent = setUpBaseComponent(1000, 2000, 5000)
			// Forked at the real first occurrence, and then moved
			const firstRealOccurrence = setUpEventComponent(5000, 5500, 6500)
			const calendarObject = {
				calendarId: 'calendar-1',
				calendarComponent: {
					getComponentIterator: vi.fn().mockReturnValue([baseComponent, firstRealOccurrence]),
				},
			}
			store.calendarObject = calendarObject
			store.calendarObjectInstance = { eventComponent: firstRealOccurrence }
			vi.spyOn(calendarObjectsStore, 'updateCalendarObject').mockResolvedValue()

			await store.saveCalendarObjectInstance({
				scope: 'series',
				calendarId: 'calendar-1',
			})

			expect(baseComponent.startDate.time).toBe(5500)
			expect(baseComponent.endDate.time).toBe(6500)
			expect(showWarning).not.toHaveBeenCalled()
		})

		it('discards the date/time change and warns when a non-primary occurrence was moved', async () => {
			const store = useCalendarObjectInstanceStore()
			const calendarObjectsStore = useCalendarObjectsStore()
			// Values are whole minutes (seconds always 0) since getDateFromDateTimeValue()
			// always truncates seconds - keeps the reverted-Date assertions below exact.
			const baseComponent = setUpBaseComponent(60_000, 120_000)
			// Forked at 300_000, but then moved to 359_940/420_000
			const movedOccurrence = setUpEventComponent(300_000, 359_940, 420_000)
			const calendarObject = {
				calendarId: 'calendar-1',
				calendarComponent: {
					getComponentIterator: vi.fn().mockReturnValue([baseComponent, movedOccurrence]),
				},
			}
			store.calendarObject = calendarObject
			store.calendarObjectInstance = { eventComponent: movedOccurrence }
			vi.spyOn(calendarObjectsStore, 'updateCalendarObject').mockResolvedValue()
			// The real, unedited occurrence - what the editor should revert back to
			baseComponent.recurrenceManager.getOccurrenceAtExactly.mockReturnValue({ startDate: fakeDateTime(300_000), endDate: fakeDateTime(360_000) })

			await store.saveCalendarObjectInstance({
				scope: 'series',
				calendarId: 'calendar-1',
			})

			expect(baseComponent.startDate.time).toBe(60_000)
			expect(baseComponent.endDate.time).toBe(120_000)
			expect(showWarning).toHaveBeenCalledTimes(1)
			expect(showWarning).toHaveBeenCalledWith('translated warning')

			// The editor itself must also stop showing the discarded change -
			// otherwise it displays a time that was never actually saved, while
			// the calendar grid (reading the real, unchanged data) shows the truth.
			expect(movedOccurrence.startDate.time).toBe(300_000)
			expect(movedOccurrence.endDate.time).toBe(360_000)
			expect(store.calendarObjectInstance.startDate).toStrictEqual(new Date(300_000 * 1000))
			expect(store.calendarObjectInstance.endDate).toStrictEqual(new Date(360_000 * 1000))
		})

		it('looks up an all-day occurrence by its real DateTimeValue, not a lossy JS-Date round-trip', async () => {
			// Regression test for a real bug: the store used to look up the unedited
			// occurrence via getObjectAtRecurrenceId(calendarObject, originalRecurrenceId.jsDate),
			// which converts the DateTimeValue to a JS Date and back. That round-trip
			// silently drops the isDate (all-day) flag (DateTimeValue.fromJSDate() defaults
			// isDate to false), so the reconstructed lookup no longer matches the real
			// all-day occurrence's own recurrence-id and returns null - crashing on
			// originalOccurrence.startDate. Only a real DateTimeValue (mocks can't fake
			// isDate semantics) can catch this, hence the real, unmocked calendar-js here.
			getTimezoneManager()

			const ics = [
				'BEGIN:VCALENDAR',
				'VERSION:2.0',
				'PRODID:-//Nextcloud//calendar-js tests//EN',
				'BEGIN:VEVENT',
				'UID:all-day-series-test',
				'DTSTART;VALUE=DATE:20260907',
				'DTEND;VALUE=DATE:20260908',
				'DTSTAMP:20260901T000000Z',
				'SUMMARY:All-day recurring test',
				'RRULE:FREQ=WEEKLY;COUNT=4;BYDAY=MO',
				'END:VEVENT',
				'END:VCALENDAR',
			].join('\r\n')

			const parser = getParserManager().getParserForFileType('text/calendar')
			parser.parse(ics)
			const calendarComponent = parser.getItemIterator().next().value

			let baseComponent = null
			for (const component of calendarComponent.getComponentIterator()) {
				if (component.name === 'VEVENT' && !component.hasProperty('RECURRENCE-ID')) {
					baseComponent = component
				}
			}
			const rangeEnd = baseComponent.startDate.clone()
			rangeEnd.year += 1
			const secondOccurrence = baseComponent.recurrenceManager.getAllOccurrencesBetween(baseComponent.startDate, rangeEnd)[1]
			const secondOccurrenceRecurrenceId = secondOccurrence.getReferenceRecurrenceId()
			expect(secondOccurrenceRecurrenceId.isDate).toBe(true)

			// What the store now does: pass the DateTimeValue straight through, no JS-Date round-trip
			const viaDirectLookup = baseComponent.recurrenceManager.getOccurrenceAtExactly(secondOccurrenceRecurrenceId)
			expect(viaDirectLookup).not.toBeNull()
			expect(viaDirectLookup.startDate.compare(secondOccurrenceRecurrenceId)).toBe(0)

			// What the store used to do: DateTimeValue -> JS Date -> DateTimeValue, losing isDate
			const jsDateRoundTripped = DateTimeValue.fromJSDate(secondOccurrenceRecurrenceId.jsDate, true)
			expect(jsDateRoundTripped.isDate).toBe(false)
			expect(baseComponent.recurrenceManager.getOccurrenceAtExactly(jsDateRoundTripped)).toBeNull()
		})
	})
})
