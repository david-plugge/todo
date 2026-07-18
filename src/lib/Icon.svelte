<script lang="ts" module>
	// Lucide icons via unplugin-icons, keyed by the app's stable icon names so
	// call sites (and dynamic `meta.icon`/`v.icon` values) stay unchanged.
	import Calendar from '~icons/lucide/calendar';
	import Inbox from '~icons/lucide/inbox';
	import CalendarClock from '~icons/lucide/calendar-clock';
	import List from '~icons/lucide/list';
	import Plus from '~icons/lucide/plus';
	import Check from '~icons/lucide/check';
	import Flag from '~icons/lucide/flag';
	import Trash from '~icons/lucide/trash-2';
	import X from '~icons/lucide/x';
	import Grip from '~icons/lucide/grip-vertical';
	import Dot from '~icons/lucide/dot';
	import Cloud from '~icons/lucide/cloud';
	import Refresh from '~icons/lucide/refresh-cw';
	import Logout from '~icons/lucide/log-out';
	import Folder from '~icons/lucide/folder';
	import Sun from '~icons/lucide/sun';
	import ArrowRight from '~icons/lucide/arrow-right';
	import Armchair from '~icons/lucide/armchair';
	import ChevronDown from '~icons/lucide/chevron-down';
	import ChevronLeft from '~icons/lucide/chevron-left';
	import ChevronRight from '~icons/lucide/chevron-right';

	type IconName = keyof typeof icons;

	const icons = {
		today: Calendar,
		inbox: Inbox,
		upcoming: CalendarClock,
		all: List,
		plus: Plus,
		check: Check,
		calendar: Calendar,
		flag: Flag,
		trash: Trash,
		x: X,
		grip: Grip,
		dot: Dot,
		cloud: Cloud,
		refresh: Refresh,
		logout: Logout,
		projects: Folder,
		sun: Sun,
		next: ArrowRight,
		weekend: Armchair,
		'chevron-down': ChevronDown,
		'chevron-left': ChevronLeft,
		'chevron-right': ChevronRight,
	};
</script>

<script lang="ts">
	type Props = {
		name: IconName | string;
		fallback?: IconName;
		size?: number;
	};

	let { name, fallback, size = 16 }: Props = $props();

	const Glyph = $derived(icons[name as keyof typeof icons] ?? (fallback && icons[fallback]) ?? Dot);
</script>

<Glyph width={size} height={size} aria-hidden="true" />
