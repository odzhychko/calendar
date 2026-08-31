/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { showWarning } from '@nextcloud/dialogs'
import { translate } from '@nextcloud/l10n'
import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it, vi } from 'vitest'
import { mapAlarmComponentToAlarmObject } from '@/models/alarm.js'
import { copyCalendarObjectInstanceIntoEventComponent, mapEventComponentToEventObject } from '@/models/event.js'
import useCalendarObjectInstanceStore from '@/store/calendarObjectInstance.js'
import useCalendarObjectsStore from '@/store/calendarObjects.js'
import { getObjectAtRecurrenceId } from '@/utils/calendarObject.js'

vi.mock('@/models/alarm.js')
vi.mock('@/models/event.js')
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
 * occurrence's date/time was changed.
 *
 * @param time Point in time, in arbitrary units
 */
function fakeDateTime(time: number) {
	return {
		time,
		compare(other: { time: number }) {
			if (this.time === other.time) {
				return 0
			}
			return this.time < other.time ? -1 : 1
		},
		clone() {
			return fakeDateTime(this.time)
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
		 * @param baseStart Base component's original start time
		 * @param baseEnd Base component's original end time
		 */
		function setUpBaseComponent(baseStart: number, baseEnd: number) {
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

		it('discards the date/time change and warns when a non-primary occurrence was moved', async () => {
			const store = useCalendarObjectInstanceStore()
			const calendarObjectsStore = useCalendarObjectsStore()
			const baseComponent = setUpBaseComponent(1000, 2000)
			// Forked at 5000, but then moved to 5999/7000
			const movedOccurrence = setUpEventComponent(5000, 5999, 7000)
			const calendarObject = {
				calendarId: 'calendar-1',
				calendarComponent: {
					getComponentIterator: vi.fn().mockReturnValue([baseComponent, movedOccurrence]),
				},
			}
			store.calendarObject = calendarObject
			store.calendarObjectInstance = { eventComponent: movedOccurrence }
			vi.spyOn(calendarObjectsStore, 'updateCalendarObject').mockResolvedValue()

			await store.saveCalendarObjectInstance({
				scope: 'series',
				calendarId: 'calendar-1',
			})

			expect(baseComponent.startDate.time).toBe(1000)
			expect(baseComponent.endDate.time).toBe(2000)
			expect(showWarning).toHaveBeenCalledTimes(1)
			expect(showWarning).toHaveBeenCalledWith('translated warning')
		})
	})
})
