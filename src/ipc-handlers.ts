import { exec, ExecOptions } from 'child_process';
import crypto from 'crypto';
import {
	BrowserWindow,
	app,
	clipboard,
	dialog,
	shell,
	type IpcMainInvokeEvent,
	Notification,
	SaveDialogOptions,
} from 'electron';
import fs from 'fs';
import fsPromises from 'fs/promises';
import https from 'node:https';
import nodePath from 'path';
import * as Sentry from '@sentry/electron/main';
import { __, LocaleData, defaultI18n } from '@wordpress/i18n';
import archiver from 'archiver';
import { DEFAULT_PHP_VERSION } from '../vendor/wp-now/src/constants';
import { MAIN_MIN_WIDTH, SIDEBAR_WIDTH } from './constants';
import { ACTIVE_SYNC_OPERATIONS } from './lib/active-sync-operations';
import { calculateDirectorySize } from './lib/calculate-directory-size';
import { download } from './lib/download';
import { isEmptyDir, pathExists, isWordPressDirectory, sanitizeFolderName } from './lib/fs-utils';
import { getImageData } from './lib/get-image-data';
import { getSyncBackupTempPath } from './lib/get-sync-backup-temp-path';
import { exportBackup } from './lib/import-export/export/export-manager';
import { ExportOptions } from './lib/import-export/export/types';
import { ImportExportEventData } from './lib/import-export/handle-events';
import { defaultImporterOptions, importBackup } from './lib/import-export/import/import-manager';
import { BackupArchiveInfo } from './lib/import-export/import/types';
import { isErrnoException } from './lib/is-errno-exception';
import { isInstalled } from './lib/is-installed';
import { SupportedLocale } from './lib/locale';
import { getUserLocaleWithFallback } from './lib/locale-node';
import * as oauthClient from './lib/oauth';
import { createPassword } from './lib/passwords';
import { phpGetThemeDetails } from './lib/php-get-theme-details';
import { shellOpenExternalWrapper } from './lib/shell-open-external-wrapper';
import { sortSites } from './lib/sort-sites';
import { installSqliteIntegration, keepSqliteIntegrationUpdated } from './lib/sqlite-versions';
import * as windowsHelpers from './lib/windows-helpers';
import { getLogsFilePath, writeLogToFile, type LogLevel } from './logging';
import { getMainWindow } from './main-window';
import { popupMenu, setupMenu } from './menu';
import { SiteServer, createSiteWorkingDirectory } from './site-server';
import { DEFAULT_SITE_PATH, getResourcesPath, getSiteThumbnailPath } from './storage/paths';
import { loadUserData, saveUserData } from './storage/user-data';
import type { SyncSite } from './hooks/use-fetch-wpcom-sites/types';
import type { WpCliResult } from './lib/wp-cli-process';

const TEMP_DIR = nodePath.join( app.getPath( 'temp' ), 'com.wordpress.studio' ) + nodePath.sep;
if ( ! fs.existsSync( TEMP_DIR ) ) {
	fs.mkdirSync( TEMP_DIR );
}

async function sendThumbnailChangedEvent( event: IpcMainInvokeEvent, id: string ) {
	if ( event.sender.isDestroyed() ) {
		return;
	}
	const thumbnailData = await getThumbnailData( event, id );
	const parentWindow = BrowserWindow.fromWebContents( event.sender );
	if ( parentWindow && ! parentWindow.isDestroyed() ) {
		parentWindow.webContents.send( 'thumbnail-changed', id, thumbnailData );
	}
}

async function mergeSiteDetailsWithRunningDetails(
	sites: SiteDetails[]
): Promise< SiteDetails[] > {
	return sites.map( ( site ) => {
		const server = SiteServer.get( site.id );
		if ( server ) {
			return server.details;
		}
		return site;
	} );
}

export async function getSiteDetails( _event: IpcMainInvokeEvent ): Promise< SiteDetails[] > {
	const userData = await loadUserData();

	const { sites } = userData;

	// Ensure we have an instance of a server for each site we know about
	for ( const site of sites ) {
		if ( ! SiteServer.get( site.id ) && ! site.running ) {
			SiteServer.create( site );
		}
	}

	return mergeSiteDetailsWithRunningDetails( sites );
}

export async function getInstalledApps( _event: IpcMainInvokeEvent ): Promise< InstalledApps > {
	return {
		vscode: isInstalled( 'vscode' ),
		phpstorm: isInstalled( 'phpstorm' ),
	};
}

export async function importSite(
	event: IpcMainInvokeEvent,
	{ id, backupFile }: { id: string; backupFile: BackupArchiveInfo }
): Promise< SiteDetails | undefined > {
	const site = SiteServer.get( id );
	if ( ! site ) {
		throw new Error( 'Site not found.' );
	}
	try {
		const onEvent = ( data: ImportExportEventData ) => {
			const parentWindow = BrowserWindow.fromWebContents( event.sender );
			if ( parentWindow && ! parentWindow.isDestroyed() && ! event.sender.isDestroyed() ) {
				parentWindow.webContents.send( 'on-import', data, id );
			}
		};
		const result = await importBackup( backupFile, site.details, onEvent, defaultImporterOptions );
		if ( ! result ) {
			return;
		}
		if ( result?.meta?.phpVersion ) {
			site.details.phpVersion = result.meta.phpVersion;
		}
		return site.details;
	} catch ( e ) {
		Sentry.captureException( e );
		throw e;
	}
}

export async function createSite(
	event: IpcMainInvokeEvent,
	path: string,
	siteName?: string
): Promise< SiteDetails[] > {
	const userData = await loadUserData();
	const forceSetupSqlite = false;
	// We only recursively create the directory if the user has not selected a
	// path from the dialog (and thus they use the "default" or suggested path).
	if ( ! ( await pathExists( path ) ) && path.startsWith( DEFAULT_SITE_PATH ) ) {
		fs.mkdirSync( path, { recursive: true } );
	}

	if ( ! ( await isEmptyDir( path ) ) && ! isWordPressDirectory( path ) ) {
		// Form validation should've prevented a non-empty directory from being selected
		throw new Error( 'The selected directory is not empty nor an existing WordPress site.' );
	}

	const allPaths = userData?.sites?.map( ( site ) => site.path ) || [];
	if ( allPaths.includes( path ) ) {
		return userData.sites;
	}

	if ( ( await pathExists( path ) ) && ( await isEmptyDir( path ) ) ) {
		try {
			await createSiteWorkingDirectory( path );
		} catch ( error ) {
			// If site creation failed, remove the generated files and re-throw the
			// error so it can be handled by the caller.
			shell.trashItem( path );
			throw error;
		}
	}

	const details = {
		id: crypto.randomUUID(),
		name: siteName || nodePath.basename( path ),
		path,
		adminPassword: createPassword(),
		running: false,
		phpVersion: DEFAULT_PHP_VERSION,
	} as const;

	const server = SiteServer.create( details );

	if ( isWordPressDirectory( path ) ) {
		// If the directory contains a WordPress installation, and user wants to force SQLite
		// integration, let's rename the wp-config.php file to allow WP Now to create a new one
		// and initialize things properly.
		if ( forceSetupSqlite && ( await pathExists( nodePath.join( path, 'wp-config.php' ) ) ) ) {
			fs.renameSync(
				nodePath.join( path, 'wp-config.php' ),
				nodePath.join( path, 'wp-config-studio.php' )
			);
		}

		if ( ! ( await pathExists( nodePath.join( path, 'wp-config.php' ) ) ) ) {
			await installSqliteIntegration( path );
		}
	}

	const parentWindow = BrowserWindow.fromWebContents( event.sender );
	if ( parentWindow && ! parentWindow.isDestroyed() && ! event.sender.isDestroyed() ) {
		parentWindow.webContents.send( 'theme-details-updating', details.id );
	}

	userData.sites.push( server.details );
	sortSites( userData.sites );
	await saveUserData( userData );

	return mergeSiteDetailsWithRunningDetails( userData.sites );
}

export async function updateSite(
	event: IpcMainInvokeEvent,
	updatedSite: SiteDetails
): Promise< SiteDetails[] > {
	const userData = await loadUserData();
	const updatedSites = userData.sites.map( ( site ) =>
		site.id === updatedSite.id ? updatedSite : site
	);
	userData.sites = updatedSites;

	const server = SiteServer.get( updatedSite.id );
	if ( server ) {
		server.updateSiteDetails( updatedSite );
	}
	await saveUserData( userData );
	return mergeSiteDetailsWithRunningDetails( userData.sites );
}

type WpcomSitesToConnect = { sites: SyncSite[]; localSiteId: string }[];

export async function connectWpcomSites( event: IpcMainInvokeEvent, list: WpcomSitesToConnect ) {
	const userData = await loadUserData();
	const currentUserId = userData.authToken?.id;

	if ( ! currentUserId ) {
		throw new Error( 'User not authenticated' );
	}

	userData.connectedWpcomSites = userData.connectedWpcomSites || {};
	userData.connectedWpcomSites[ currentUserId ] =
		userData.connectedWpcomSites[ currentUserId ] || [];

	const connections = userData.connectedWpcomSites[ currentUserId ];

	list.forEach( ( { sites, localSiteId } ) => {
		sites.forEach( ( siteToAdd ) => {
			const isAlreadyConnected = connections.some(
				( conn ) => conn.id === siteToAdd.id && conn.localSiteId === localSiteId
			);

			// Add the site if it's not already connected
			if ( ! isAlreadyConnected ) {
				connections.push( {
					...siteToAdd,
					localSiteId,
					syncSupport: 'already-connected',
				} );
			}
		} );
	} );

	await saveUserData( userData );

	return connections.filter( ( conn ) =>
		list.some( ( { localSiteId } ) => conn.localSiteId === localSiteId )
	);
}

type WpcomSitesToDisconnect = { siteIds: number[]; localSiteId: string }[];

export async function disconnectWpcomSites(
	event: IpcMainInvokeEvent,
	list: WpcomSitesToDisconnect
) {
	const userData = await loadUserData();
	const currentUserId = userData.authToken?.id;

	if ( ! currentUserId ) {
		throw new Error( 'User not authenticated' );
	}

	const connectedWpcomSites = userData.connectedWpcomSites;

	// Totally unreal case, added it to help TS parse the code below. And if this error happens, we definitely have something wrong.
	if ( ! Array.isArray( connectedWpcomSites?.[ currentUserId ] ) ) {
		throw new Error(
			'Something went wrong, since you are trying to disconnect something, but there are no stored connections yet'
		);
	}

	list.forEach( ( { siteIds, localSiteId } ) => {
		const updatedConnections = connectedWpcomSites[ currentUserId ].filter(
			( conn ) => ! ( siteIds.includes( conn.id ) && conn.localSiteId === localSiteId )
		);

		connectedWpcomSites[ currentUserId ] = updatedConnections;
	} );

	await saveUserData( userData );

	return connectedWpcomSites[ currentUserId ].filter( ( conn ) =>
		list.some( ( { localSiteId } ) => conn.localSiteId === localSiteId )
	);
}

export async function updateConnectedWpcomSites(
	event: IpcMainInvokeEvent,
	updatedSites: SyncSite[]
) {
	const userData = await loadUserData();
	const currentUserId = userData.authToken?.id;

	if ( ! currentUserId ) {
		throw new Error( 'User not authenticated' );
	}

	const connections = userData.connectedWpcomSites?.[ currentUserId ] || [];

	if ( ! connections.length ) {
		return;
	}

	updatedSites.forEach( ( updatedSite ) => {
		const index = connections.findIndex(
			( conn ) => conn.id === updatedSite.id && conn.localSiteId === updatedSite.localSiteId
		);

		if ( index !== -1 ) {
			connections[ index ] = updatedSite;
		}
	} );

	await saveUserData( userData );
}

export async function updateSingleConnectedWpcomSite(
	event: IpcMainInvokeEvent,
	updatedSite: SyncSite
) {
	const userData = await loadUserData();
	const currentUserId = userData.authToken?.id;

	if ( ! currentUserId ) {
		throw new Error( 'User not authenticated' );
	}

	const connections = userData.connectedWpcomSites?.[ currentUserId ] || [];

	if ( ! connections.length ) {
		return;
	}

	const index = connections.findIndex(
		( conn ) => conn.id === updatedSite.id && conn.localSiteId === updatedSite.localSiteId
	);

	if ( index !== -1 ) {
		connections[ index ] = updatedSite;
		await saveUserData( userData );
	}
}

export async function getConnectedWpcomSites(
	event: IpcMainInvokeEvent,
	localSiteId?: string
): Promise< SyncSite[] > {
	const userData = await loadUserData();

	const currentUserId = userData.authToken?.id;

	if ( ! currentUserId ) {
		return [];
	}

	const allConnected = userData.connectedWpcomSites?.[ currentUserId ] || [];

	if ( localSiteId ) {
		return allConnected.filter( ( site ) => site.localSiteId === localSiteId );
	} else {
		return allConnected;
	}
}

export async function startServer(
	event: IpcMainInvokeEvent,
	id: string
): Promise< SiteDetails | null > {
	const server = SiteServer.get( id );
	if ( ! server ) {
		return null;
	}

	await keepSqliteIntegrationUpdated( server.details.path );

	const parentWindow = BrowserWindow.fromWebContents( event.sender );
	try {
		await server.start();
	} catch ( error ) {
		Sentry.captureException( error );
		if (
			error instanceof Error &&
			error.message.includes( '"unreachable" WASM instruction executed' )
		) {
			throw new Error( 'Please try disabling plugins and themes that might be causing the issue.' );
		}
		throw error;
	}
	if ( parentWindow && ! parentWindow.isDestroyed() && ! event.sender.isDestroyed() ) {
		parentWindow.webContents.send( 'theme-details-changed', id, server.details.themeDetails );
	}

	if ( server.details.running ) {
		try {
			await server.updateCachedThumbnail();
			sendThumbnailChangedEvent( event, id );
		} catch ( error ) {
			console.error( `Failed to update thumbnail for server ${ id }:`, error );
		}
	}

	console.log( `Server started for '${ server.details.name }'` );
	await updateSite( event, server.details );
	return server.details;
}

export async function stopServer(
	event: IpcMainInvokeEvent,
	id: string
): Promise< SiteDetails | null > {
	const server = SiteServer.get( id );
	if ( ! server ) {
		return null;
	}

	await server.stop();
	return server.details;
}

export interface FolderDialogResponse {
	path: string;
	name: string;
	isEmpty: boolean;
	isWordPress: boolean;
}

export async function showSaveAsDialog( event: IpcMainInvokeEvent, options: SaveDialogOptions ) {
	const parentWindow = BrowserWindow.fromWebContents( event.sender );
	if ( ! parentWindow ) {
		throw new Error( `No window found for sender of showSaveAsDialog message: ${ event.frameId }` );
	}

	const defaultPath =
		options.defaultPath === nodePath.basename( options.defaultPath ?? '' )
			? nodePath.join( DEFAULT_SITE_PATH, options.defaultPath )
			: options.defaultPath;
	const { canceled, filePath } = await dialog.showSaveDialog( parentWindow, {
		defaultPath,
		...options,
	} );
	if ( canceled ) {
		return '';
	}
	return filePath;
}

export async function showOpenFolderDialog(
	event: IpcMainInvokeEvent,
	title: string,
	defaultDialogPath: string
): Promise< FolderDialogResponse | null > {
	const parentWindow = BrowserWindow.fromWebContents( event.sender );
	if ( ! parentWindow ) {
		throw new Error(
			`No window found for sender of showOpenFolderDialog message: ${ event.frameId }`
		);
	}

	if ( process.env.E2E && process.env.E2E_OPEN_FOLDER_DIALOG ) {
		// Playwright's filechooser event isn't working in our e2e tests.
		// Use an environment variable to manually set which folder gets selected.
		return {
			path: process.env.E2E_OPEN_FOLDER_DIALOG,
			name: nodePath.basename( process.env.E2E_OPEN_FOLDER_DIALOG ),
			isEmpty: await isEmptyDir( process.env.E2E_OPEN_FOLDER_DIALOG ),
			isWordPress: isWordPressDirectory( process.env.E2E_OPEN_FOLDER_DIALOG ),
		};
	}

	const { canceled, filePaths } = await dialog.showOpenDialog( parentWindow, {
		title,
		defaultPath: defaultDialogPath !== '' ? defaultDialogPath : DEFAULT_SITE_PATH,
		properties: [
			'openDirectory',
			'createDirectory', // allow user to create new directories; macOS only
		],
	} );
	if ( canceled ) {
		return null;
	}

	return {
		path: filePaths[ 0 ],
		name: nodePath.basename( filePaths[ 0 ] ),
		isEmpty: await isEmptyDir( filePaths[ 0 ] ),
		isWordPress: isWordPressDirectory( filePaths[ 0 ] ),
	};
}

export async function saveUserLocale( _event: IpcMainInvokeEvent, locale: string ) {
	const userData = await loadUserData();
	await saveUserData( {
		...userData,
		locale,
	} );
}

export async function getSentryUserId( _event: IpcMainInvokeEvent ): Promise< string | undefined > {
	const userData = await loadUserData();
	return userData.sentryUserId;
}

export async function getUserLocale( _event: IpcMainInvokeEvent ): Promise< SupportedLocale > {
	return getUserLocaleWithFallback();
}

export async function showUserSettings( event: IpcMainInvokeEvent ): Promise< void > {
	const parentWindow = BrowserWindow.fromWebContents( event.sender );
	if ( ! parentWindow ) {
		throw new Error( `No window found for sender of showUserSettings message: ${ event.frameId }` );
	}
	if ( parentWindow.isDestroyed() || event.sender.isDestroyed() ) {
		return;
	}
	parentWindow.webContents.send( 'user-settings' );
}

function archiveWordPressDirectory( {
	source,
	archivePath,
	format,
}: {
	source: string;
	archivePath: string;
	format: 'zip' | 'tar';
} ) {
	return new Promise( ( resolve, reject ) => {
		const output = fs.createWriteStream( archivePath );
		const archive = archiver( format, {
			zlib: { level: 9 }, // Sets the compression level.
		} );

		output.on( 'close', function () {
			resolve( archive );
		} );

		archive.on( 'error', function ( err: Error ) {
			reject( err );
		} );

		archive.pipe( output );
		// Archive site wp-content
		archive.directory( `${ source }/wp-content`, 'wp-content' );
		archive.file( `${ source }/wp-config.php`, { name: 'wp-config.php' } );

		archive.finalize();
	} );
}

export async function archiveSite( event: IpcMainInvokeEvent, id: string, format: 'zip' | 'tar' ) {
	const site = SiteServer.get( id );
	if ( ! site ) {
		throw new Error( 'Site not found.' );
	}
	const sitePath = site.details.path;
	const archivePath = `${ TEMP_DIR }site_${ id }.${ format }`;
	await archiveWordPressDirectory( {
		source: sitePath,
		archivePath,
		format,
	} );
	const stats = fs.statSync( archivePath );
	return { archivePath, archiveSizeInBytes: stats.size };
}

export async function exportSiteToPush( event: IpcMainInvokeEvent, id: string ) {
	const site = SiteServer.get( id );
	if ( ! site ) {
		throw new Error( 'Site not found.' );
	}
	const extension = 'tar.gz';
	const archivePath = `${ TEMP_DIR }site_${ id }.${ extension }`;
	const exportOptions: ExportOptions = {
		site: site.details,
		backupFile: archivePath,
		includes: { database: true, uploads: true, plugins: true, themes: true },
		phpVersion: site.details.phpVersion,
		splitDatabaseDumpByTable: true,
	};
	// eslint-disable-next-line @typescript-eslint/no-empty-function
	const onEvent = () => {};
	await exportBackup( exportOptions, onEvent );
	const stats = fs.statSync( archivePath );
	const archiveContent = fs.readFileSync( archivePath );
	return { archivePath, archiveContent, archiveSizeInBytes: stats.size };
}

export function removeTemporalFile( event: IpcMainInvokeEvent, path: string ) {
	if ( ! path.includes( TEMP_DIR ) ) {
		throw new Error( 'The given path is not a temporal file' );
	}
	try {
		fs.unlinkSync( path );
	} catch ( error ) {
		if ( isErrnoException( error ) && error.code === 'ENOENT' ) {
			// Silently ignore if the temporal file doesn't exist
			Sentry.captureException( error );
		}
	}
}

export async function deleteSite( event: IpcMainInvokeEvent, id: string, deleteFiles = false ) {
	const server = SiteServer.get( id );
	console.log( 'Deleting site', id );
	if ( ! server ) {
		throw new Error( 'Site not found.' );
	}
	const userData = await loadUserData();
	await server.delete();
	try {
		// Move files to trash
		if ( deleteFiles ) {
			await shell.trashItem( server.details.path );
		}
	} catch ( error ) {
		/* We want to exit gracefully if the there is an error deleting the site files */
		Sentry.captureException( error );
	}
	const newSites = userData.sites.filter( ( site ) => site.id !== id );
	const newUserData = { ...userData, sites: newSites };
	await saveUserData( newUserData );
	return mergeSiteDetailsWithRunningDetails( newSites );
}

export function logRendererMessage(
	event: IpcMainInvokeEvent,
	level: LogLevel,
	...args: unknown[]
): void {
	// 4 characters long so it aligns with the main process logs
	const processId = `ren${ event.sender.id }`;
	writeLogToFile( level, processId, ...args );
}

export function authenticate( _event: IpcMainInvokeEvent ) {
	oauthClient.authenticate();
}

export async function getAuthenticationToken(
	_event: IpcMainInvokeEvent
): Promise< oauthClient.StoredToken | null > {
	return oauthClient.getAuthenticationToken();
}

export async function isAuthenticated() {
	return oauthClient.isAuthenticated();
}

export async function clearAuthenticationToken() {
	return oauthClient.clearAuthenticationToken();
}

export async function exportSite(
	event: IpcMainInvokeEvent,
	options: ExportOptions,
	siteId: string
): Promise< boolean > {
	try {
		const onEvent = ( data: ImportExportEventData ) => {
			const parentWindow = BrowserWindow.fromWebContents( event.sender );
			if ( parentWindow && ! parentWindow.isDestroyed() && ! event.sender.isDestroyed() ) {
				parentWindow.webContents.send( 'on-export', data, siteId );
			}
		};
		return await exportBackup( options, onEvent );
	} catch ( e ) {
		Sentry.captureException( e );
		throw e;
	}
}

export async function saveSnapshotsToStorage( event: IpcMainInvokeEvent, snapshots: Snapshot[] ) {
	const userData = await loadUserData();
	await saveUserData( {
		...userData,
		snapshots: snapshots.map( ( { isLoading, ...restSnapshots } ) => restSnapshots ),
	} );
}

export async function getSnapshots( _event: IpcMainInvokeEvent ): Promise< Snapshot[] > {
	const userData = await loadUserData();
	const { snapshots = [] } = userData;
	return snapshots;
}

export function openSiteURL(
	event: IpcMainInvokeEvent,
	id: string,
	relativeURL = '',
	{ autoLogin = true }: { autoLogin?: boolean } = {}
) {
	const site = SiteServer.get( id );
	if ( ! site ) {
		throw new Error( 'Site not found.' );
	}
	if ( ! site.server?.url ) {
		throw new Error( 'Site server URL not found.' );
	}
	const url = new URL( site.server.url + relativeURL );
	if ( autoLogin ) {
		url.searchParams.append( 'playground-auto-login', 'true' );
	}

	shellOpenExternalWrapper( url.toString() );
}

export function openURL( event: IpcMainInvokeEvent, url: string ) {
	shellOpenExternalWrapper( url );
}

export async function copyText( event: IpcMainInvokeEvent, text: string ) {
	return clipboard.writeText( text );
}

export async function getAppGlobals( _event: IpcMainInvokeEvent ): Promise< AppGlobals > {
	return {
		platform: process.platform,
		appName: app.name,
		arm64Translation: app.runningUnderARM64Translation,
		terminalWpCliEnabled: process.env.STUDIO_TERMINAL_WP_CLI === 'true',
		quickDeploysEnabled: process.env.STUDIO_QUICK_DEPLOYS === 'true',
	};
}

export async function getWpVersion( _event: IpcMainInvokeEvent, id: string ) {
	const server = SiteServer.get( id );
	if ( ! server ) {
		return '-';
	}
	const wordPressPath = server.details.path;
	let versionFileContent = '';
	try {
		versionFileContent = fs.readFileSync(
			nodePath.join( wordPressPath, 'wp-includes', 'version.php' ),
			'utf8'
		);
	} catch ( err ) {
		return '-';
	}
	const matches = versionFileContent.match( /\$wp_version\s*=\s*'([0-9a-zA-Z.-]+)'/ );
	return matches?.[ 1 ] || '-';
}

export async function generateProposedSitePath(
	_event: IpcMainInvokeEvent,
	siteName: string
): Promise< FolderDialogResponse > {
	const path = nodePath.join( DEFAULT_SITE_PATH, sanitizeFolderName( siteName ) );

	try {
		return {
			path,
			name: siteName,
			isEmpty: await isEmptyDir( path ),
			isWordPress: isWordPressDirectory( path ),
		};
	} catch ( err ) {
		if ( isErrnoException( err ) && err.code === 'ENOENT' ) {
			return {
				path,
				name: siteName,
				isEmpty: true,
				isWordPress: false,
			};
		}
		throw err;
	}
}

export async function openLocalPath( _event: IpcMainInvokeEvent, path: string ) {
	shell.openPath( path );
}

export async function showItemInFolder( _event: IpcMainInvokeEvent, path: string ) {
	shell.showItemInFolder( path );
}

export async function getThemeDetails( event: IpcMainInvokeEvent, id: string ) {
	const server = SiteServer.get( id );
	if ( ! server ) {
		throw new Error( 'Site not found.' );
	}

	if ( ! server.details.running || ! server.server ) {
		return null;
	}
	const themeDetails = await phpGetThemeDetails( server.server );

	const parentWindow = BrowserWindow.fromWebContents( event.sender );
	if ( themeDetails?.path && themeDetails.path !== server.details.themeDetails?.path ) {
		if ( parentWindow && ! parentWindow.isDestroyed() && ! event.sender.isDestroyed() ) {
			parentWindow.webContents.send( 'theme-details-updating', id );
		}
		const updatedSite = {
			...server.details,
			themeDetails,
		};
		if ( parentWindow && ! parentWindow.isDestroyed() && ! event.sender.isDestroyed() ) {
			parentWindow.webContents.send( 'theme-details-changed', id, themeDetails );
		}

		server.updateCachedThumbnail().then( () => sendThumbnailChangedEvent( event, id ) );
		server.details.themeDetails = themeDetails;
		await updateSite( event, updatedSite );
	}
	return themeDetails;
}

export async function getOnboardingData( _event: IpcMainInvokeEvent ): Promise< boolean > {
	const userData = await loadUserData();
	const { onboardingCompleted = false } = userData;
	return onboardingCompleted;
}

export async function saveOnboarding(
	_event: IpcMainInvokeEvent,
	onboardingCompleted: boolean
): Promise< void > {
	const userData = await loadUserData();
	await saveUserData( {
		...userData,
		onboardingCompleted,
	} );
}

export async function executeWPCLiInline(
	_event: IpcMainInvokeEvent,
	{
		siteId,
		args,
		skipPluginsAndThemes = false,
	}: {
		siteId: string;
		args: string;
		skipPluginsAndThemes?: boolean;
	}
): Promise< WpCliResult > {
	if ( SiteServer.isDeleted( siteId ) ) {
		return {
			stdout: '',
			stderr: `Cannot execute command on deleted site ${ siteId }`,
			exitCode: 1,
		};
	}
	const server = SiteServer.get( siteId );
	if ( ! server ) {
		throw new Error( 'Site not found.' );
	}
	return server.executeWpCliCommand( args, {
		skipPluginsAndThemes,
	} );
}

export async function getThumbnailData( _event: IpcMainInvokeEvent, id: string ) {
	const path = getSiteThumbnailPath( id );
	return getImageData( path );
}

function promiseExec( command: string, options: ExecOptions = {} ): Promise< void > {
	return new Promise( ( resolve, reject ) => {
		exec( command, options, ( error ) => {
			if ( error ) {
				reject( error );
				return;
			}
			resolve();
		} );
	} );
}

export function openTerminalAtPath(
	_event: IpcMainInvokeEvent,
	targetPath: string,
	{ wpCliEnabled }: { wpCliEnabled?: boolean } = {}
) {
	const platform = process.platform;
	const cliPath = nodePath.join( getResourcesPath(), 'bin' );

	const exePath = app.getPath( 'exe' );
	const appDirectory = app.getAppPath();
	const appPath = ! app.isPackaged ? `${ exePath } ${ appDirectory }` : exePath;

	if ( platform === 'win32' ) {
		const defaultShell = process.env.ComSpec || 'cmd.exe';
		const env = wpCliEnabled
			? { PATH: `${ cliPath };${ process.env.PATH }`, STUDIO_APP_PATH: appPath }
			: {};

		return promiseExec( `start "Command Prompt" ${ defaultShell }`, {
			cwd: targetPath,
			env: { ...process.env, ...env },
		} );
	} else if ( platform === 'darwin' ) {
		const loadWpCliCommand = `clear && export PATH=\\"${ cliPath }\\":$PATH && export STUDIO_APP_PATH=\\"${ appPath }\\" &&`;
		const osascript = `
		tell application "Terminal"
			if not application "Terminal" is running then launch
			do script "${ wpCliEnabled ? loadWpCliCommand : '' } cd ${ targetPath } && clear"
			activate
		end tell`;

		return promiseExec( `osascript -e '${ osascript }'` );
	} else if ( platform === 'linux' ) {
		if ( wpCliEnabled ) {
			return promiseExec(
				`export PATH=${ cliPath }:$PATH && export STUDIO_APP_PATH="${ appPath }" && gnome-terminal -- bash -c 'cd ${ targetPath }; exec bash'`
			);
		}

		return promiseExec( `gnome-terminal --working-directory=${ targetPath }` );
	} else {
		console.error( 'Unsupported platform:', platform );
		return;
	}
}

export async function showMessageBox(
	event: IpcMainInvokeEvent,
	options: Electron.MessageBoxOptions
) {
	const parentWindow = BrowserWindow.fromWebContents( event.sender );
	if ( parentWindow && ! parentWindow.isDestroyed() && ! event.sender.isDestroyed() ) {
		return dialog.showMessageBox( parentWindow, options );
	}
	return dialog.showMessageBox( options );
}

export async function showErrorMessageBox(
	event: IpcMainInvokeEvent,
	{
		title,
		message,
		error,
		showOpenLogs = false,
	}: { title: string; message: string; error?: unknown; showOpenLogs?: boolean }
) {
	// Remove prepended error message added by IPC handler
	const filteredError = ( error as Error )?.message?.replace(
		/Error invoking remote method '\w+': Error:/g,
		''
	);
	const response = await showMessageBox( event, {
		type: 'error',
		message: title,
		detail: error ? `${ message }\n\n${ filteredError }` : message,
		buttons: [ ...( showOpenLogs ? [ __( 'Open Studio Logs' ) ] : [] ), __( 'OK' ) ],
	} );

	if ( showOpenLogs && response.response === 0 ) {
		const logFilePath = getLogsFilePath();
		const err = await shell.openPath( logFilePath );
		if ( err ) {
			console.error( `Error opening logs file: ${ logFilePath } ${ err }` );
		}
	}
}

export async function showNotification(
	_event: IpcMainInvokeEvent,
	options: Electron.NotificationConstructorOptions
) {
	new Notification( options ).show();
}

export async function setupAppMenu(
	_event: IpcMainInvokeEvent,
	config: { needsOnboarding: boolean }
) {
	await setupMenu( config );
}

export async function popupAppMenu( _event: IpcMainInvokeEvent ) {
	await popupMenu();
}

export async function promptWindowsSpeedUpSites(
	_event: IpcMainInvokeEvent,
	{ skipIfAlreadyPrompted }: { skipIfAlreadyPrompted: boolean }
) {
	await windowsHelpers.promptWindowsSpeedUpSites( { skipIfAlreadyPrompted } );
}

export function setDefaultLocaleData( _event: IpcMainInvokeEvent, locale?: LocaleData ) {
	defaultI18n.setLocaleData( locale );
}

export function resetDefaultLocaleData( _event: IpcMainInvokeEvent ) {
	defaultI18n.resetLocaleData();
}

export function toggleMinWindowWidth( event: IpcMainInvokeEvent, isSidebarVisible: boolean ) {
	const parentWindow = BrowserWindow.fromWebContents( event.sender );
	if ( ! parentWindow || parentWindow.isDestroyed() || event.sender.isDestroyed() ) {
		return;
	}
	const [ currentWidth, currentHeight ] = parentWindow.getSize();
	const newWidth = Math.max(
		MAIN_MIN_WIDTH,
		isSidebarVisible ? currentWidth - SIDEBAR_WIDTH : currentWidth + SIDEBAR_WIDTH
	);
	parentWindow.setSize( newWidth, currentHeight, true );
}

/**
 * Returns the absolute path of a file in the site's directory.
 * Returns null if the file does not exist.
 */
export async function getAbsolutePathFromSite(
	_event: IpcMainInvokeEvent,
	siteId: string,
	relativePath: string
): Promise< string | null > {
	const server = SiteServer.get( siteId );
	if ( ! server ) {
		throw new Error( 'Site not found.' );
	}

	const path = nodePath.join( server.details.path, relativePath );
	return ( await pathExists( path ) ) ? path : null;
}

/**
 * Opens a file in the IDE with the site context.
 */
export async function openFileInIDE(
	_event: IpcMainInvokeEvent,
	relativePath: string,
	siteId: string
) {
	const server = SiteServer.get( siteId );
	if ( ! server ) {
		throw new Error( 'Site not found.' );
	}

	const path = await getAbsolutePathFromSite( _event, siteId, relativePath );
	if ( ! path ) {
		return;
	}

	if ( isInstalled( 'vscode' ) ) {
		// Open site first to ensure the file is opened within the site context
		await shell.openExternal( `vscode://file/${ server.details.path }?windowId=_blank` );
		await shell.openExternal( `vscode://file/${ path }` );
	} else if ( isInstalled( 'phpstorm' ) ) {
		// Open site first to ensure the file is opened within the site context
		await shell.openExternal( `phpstorm://open?file=${ path }` );
	}
}

export async function downloadSyncBackup(
	event: Electron.IpcMainInvokeEvent,
	remoteSiteId: number,
	downloadUrl: string
) {
	const tmpDir = nodePath.join( app.getPath( 'temp' ), 'wp-studio-backups' );
	await fsPromises.mkdir( tmpDir, { recursive: true } );

	const filePath = getSyncBackupTempPath( remoteSiteId );
	await download( downloadUrl, filePath );
	return filePath;
}

export async function removeSyncBackup( event: IpcMainInvokeEvent, remoteSiteId: number ) {
	const filePath = getSyncBackupTempPath( remoteSiteId );
	await fsPromises.unlink( filePath );
}

export async function isImportExportSupported( _event: IpcMainInvokeEvent, siteId: string ) {
	const site = SiteServer.get( siteId );
	if ( ! site ) {
		throw new Error( 'Site not found.' );
	}
	return site.hasSQLitePlugin();
}

/**
 * Store the ID of a push/pull operation in a deduped set.
 */
export function addSyncOperation( event: IpcMainInvokeEvent, id: string ) {
	ACTIVE_SYNC_OPERATIONS.add( id );
}

/**
 * Clear the ID of a push/pull operation.
 */
export function clearSyncOperation( event: IpcMainInvokeEvent, id: string ) {
	ACTIVE_SYNC_OPERATIONS.delete( id );
}

export function getWpContentSize( _event: IpcMainInvokeEvent, siteId: string ) {
	const site = SiteServer.get( siteId );
	if ( ! site ) {
		throw new Error( 'Site not found.' );
	}
	return calculateDirectorySize( nodePath.join( site.details.path, 'wp-content' ) );
}
export async function getFileContent( event: IpcMainInvokeEvent, filePath: string ) {
	if ( ! fs.existsSync( filePath ) ) {
		throw new Error( `File not found: ${ filePath }` );
	}

	return fs.readFileSync( filePath );
}

/**
 * Checks the size of a sync backup file before downloading.
 * Returns the size in bytes.
 */
export async function checkSyncBackupSize(
	event: IpcMainInvokeEvent,
	downloadUrl: string
): Promise< number > {
	return new Promise( ( resolve, reject ) => {
		https
			.get( downloadUrl, { method: 'HEAD' }, ( res ) => {
				if ( res.statusCode !== 200 ) {
					reject( new Error( `Failed to fetch file size: ${ res.statusMessage }` ) );
					return;
				}

				const contentLength = res.headers[ 'content-length' ];
				if ( ! contentLength ) {
					reject( new Error( 'Content-Length header not found' ) );
					return;
				}

				resolve( parseInt( contentLength, 10 ) );
			} )
			.on( 'error', ( error: Error ) => {
				Sentry.captureException( error );
				reject( new Error( `Failed to check backup file size: ${ error.message }` ) );
			} );
	} );
}

export async function isFullscreen( _event: IpcMainInvokeEvent ): Promise< boolean > {
	const window = await getMainWindow();
	return window.isFullScreen();
}
