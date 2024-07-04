// This allows TypeScript to pick up the magic constants that's auto-generated by Forge's Webpack
// plugin that tells the Electron app where to look for the Webpack-bundled app code (depending on
// whether you're running in development or production).
declare const MAIN_WINDOW_WEBPACK_ENTRY: string;
declare const MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY: string;

// Defined in webpack.main.config.ts
declare const COMMIT_HASH: string | undefined;

interface ShowNotificationOptions extends Electron.NotificationConstructorOptions {
	showIcon: boolean;
}

interface StoppedSiteDetails {
	running: false;

	id: string;
	name: string;
	path: string;
	port?: number;
	phpVersion: string;
	adminPassword?: string;
	themeDetails?: {
		name: string;
		path: string;
		slug: string;
		isBlockTheme: boolean;
		supportsWidgets: boolean;
		supportsMenus: boolean;
	};
}

interface StartedSiteDetails extends StoppedSiteDetails {
	running: true;

	port: number;
	url: string;
}

type SiteDetails = StartedSiteDetails | StoppedSiteDetails;

interface Snapshot {
	url: string;
	atomicSiteId: number;
	localSiteId: string;
	date: number;
	isLoading?: boolean;
	isDeleting?: boolean;
}

type InstalledApps = {
	vscode: boolean | null;
	phpstorm: boolean | null;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tail< T extends any[] > = ( ( ...args: T ) => any ) extends ( _: any, ...tail: infer U ) => any
	? U
	: never;

// IpcApi functions have the same signatures as the functions in ipc-handlers.ts, except
// with the first parameter removed.
type IpcApi = {
	[ K in keyof typeof import('./ipc-handlers') ]: (
		...args: Tail< Parameters< ( typeof import('./ipc-handlers') )[ K ] > >
	) => ReturnType< ( typeof import('./ipc-handlers') )[ K ] >;
};

interface AppGlobals {
	platform: NodeJS.Platform;
	locale: string;
	localeData: LocaleData | null;
	appName: string;
	arm64Translation: boolean;
	assistantEnabled: boolean;
	terminalWpCliEnabled: boolean;
}

interface IpcListener {
	subscribe( channel: string, listener: ( ...args: any[] ) => void ): () => void;
}

// Our IPC objects will be attached to the `window` global
interface Window {
	ipcListener: IpcListener;
	ipcApi: IpcApi;
	appGlobals: AppGlobals;
}

// Network
interface WpcomNetworkError extends Error {
	code: string;
	status: number;
}
