import path from 'path';
import { rootCertificates } from 'tls';
import { createNodeFsMountHandler, loadNodeRuntime } from '@php-wasm/node';
import {
	MountHandler,
	PHP,
	PHPRequestHandler,
	proxyFileSystem,
	rotatePHPRuntime,
	setPhpIniEntries,
} from '@php-wasm/universal';
import { phpVar } from '@php-wasm/util';
import {
	StepDefinition,
	activatePlugin,
	activateTheme,
	compileBlueprint,
	defineWpConfigConsts,
	runBlueprintSteps,
} from '@wp-playground/blueprints';
import {
	wordPressRewriteRules,
	getFileNotFoundActionForWordPress,
	setupPlatformLevelMuPlugins,
} from '@wp-playground/wordpress';
import fs from 'fs-extra';
import { SymlinkManager } from '../../../src/lib/symlink-manager';
import getWpNowConfig, { WPNowOptions, WPNowMode } from './config';
import {
	PLAYGROUND_INTERNAL_MU_PLUGINS_FOLDER,
	PLAYGROUND_INTERNAL_PRELOAD_PATH,
	PLAYGROUND_INTERNAL_SHARED_FOLDER,
	SQLITE_FILENAME,
	SQLITE_PLUGIN_FOLDER,
} from './constants';
import {
	downloadWordPress,
	downloadSqliteIntegrationPlugin,
	removeDownloadedMuPlugins,
} from './download';
import getSqlitePath from './get-sqlite-path';
import getWordpressVersionsPath from './get-wordpress-versions-path';
import { output } from './output';
import {
	hasIndexFile,
	isPluginDirectory,
	isThemeDirectory,
	isWpContentDirectory,
	isWordPressDirectory,
	isWordPressDevelopDirectory,
	getPluginFile,
	readFileHead,
} from './wp-playground-wordpress';

export default async function startWPNow(
	options: Partial< WPNowOptions > = {}
): Promise< { php: PHP; options: WPNowOptions } > {
	const { documentRoot } = options;
	const requestHandler = new PHPRequestHandler( {
		phpFactory: async ( { isPrimary, requestHandler: reqHandler } ) => {
			const { php } = await getPHPInstance( options, isPrimary, reqHandler );
			if ( ! isPrimary ) {
				proxyFileSystem( await requestHandler.getPrimaryPhp(), php, [
					'/tmp',
					requestHandler.documentRoot,
					'/internal/shared',
				] );
			}

			if ( reqHandler ) {
				php.requestHandler = reqHandler;
			}

			return php;
		},
		documentRoot: documentRoot || '/wordpress',
		absoluteUrl: options.absoluteUrl,
		rewriteRules: wordPressRewriteRules,
		getFileNotFoundAction: getFileNotFoundActionForWordPress,
	} );

	const php = await requestHandler.getPrimaryPhp();

	applyOverrideUmaskWorkaround( php );
	await prepareDocumentRoot( php, options );

	output?.log( `directory: ${ options.projectPath }` );
	output?.log( `mode: ${ options.mode }` );
	output?.log( `php: ${ options.phpVersion }` );

	if ( options.mode === WPNowMode.INDEX ) {
		await runIndexMode( php, options );
		return { php, options };
	}
	output?.log( `wp: ${ options.wordPressVersion }` );
	await Promise.all( [
		downloadWordPress( options.wordPressVersion ),
		downloadSqliteIntegrationPlugin(),
	] );

	if ( options.reset ) {
		fs.removeSync( options.wpContentPath );
		output?.log( 'Created a fresh SQLite database and wp-content directory.' );
	}

	const isFirstTimeProject = ! fs.existsSync( options.wpContentPath );

	await prepareWordPress( php, options );

	if ( options.blueprintObject ) {
		output?.log( `blueprint steps: ${ options.blueprintObject.steps.length }` );
		const compiled = compileBlueprint( options.blueprintObject, {
			onStepCompleted: ( result, step: StepDefinition ) => {
				output?.log( `Blueprint step completed: ${ step.step }` );
			},
		} );
		await runBlueprintSteps( compiled, php );
	}

	await installationSteps( php, options );
	await login( php, options );

	if ( isFirstTimeProject && [ WPNowMode.PLUGIN, WPNowMode.THEME ].includes( options.mode ) ) {
		await activatePluginOrTheme( php, options );
	}

	rotatePHPRuntime( {
		php,
		cwd: requestHandler.documentRoot,
		recreateRuntime: async () => {
			output?.log( 'Recreating and rotating PHP runtime' );
			const { php, runtimeId } = await getPHPInstance( options, true, requestHandler );
			await prepareDocumentRoot( php, options );
			await prepareWordPress( php, options );
			return runtimeId;
		},
		maxRequests: 400,
	} );

	return {
		php,
		options,
	};
}

async function getPHPInstance(
	options: WPNowOptions,
	isPrimary: boolean,
	requestHandler: PHPRequestHandler
): Promise< { php: PHP; runtimeId: number } > {
	const id = await loadNodeRuntime( options.phpVersion );
	const php = new PHP( id );
	php.requestHandler = requestHandler;

	await setPhpIniEntries( php, {
		memory_limit: '256M',
		disable_functions: '',
		allow_url_fopen: '1',
		'openssl.cafile': path.posix.join( PLAYGROUND_INTERNAL_SHARED_FOLDER, 'ca-bundle.crt' ),
	} );

	return { php, runtimeId: id };
}

async function prepareDocumentRoot( php: PHP, options: WPNowOptions ) {
	php.mkdir( options.documentRoot );
	php.chdir( options.documentRoot );
	php.writeFile( `${ options.documentRoot }/index.php`, `<?php echo 'Hello wp-now!';` );
	php.writeFile(
		path.posix.join( PLAYGROUND_INTERNAL_SHARED_FOLDER, 'ca-bundle.crt' ),
		rootCertificates.join( '\n' )
	);
}

export async function prepareWordPress( php: PHP, options: WPNowOptions ) {
	/**
	 * Studio used to store internal mu-plugins in the site's mu-plugins folder.
	 * Internal mu-plugins are now mounted into Playground's internal mu-plugins folder,
	 * so we need to remove the mu-plugins from the site's mu-plugins folder.
	 */
	await removeDownloadedMuPlugins( options.projectPath );

	switch ( options.mode ) {
		case WPNowMode.WP_CONTENT:
			await runWpContentMode( php, options );
			break;
		case WPNowMode.WORDPRESS_DEVELOP:
			await runWordPressDevelopMode( php, options );
			break;
		case WPNowMode.WORDPRESS:
			await runWordPressMode( php, options );
			break;
		case WPNowMode.PLUGIN:
			await runPluginOrThemeMode( php, options );
			break;
		case WPNowMode.THEME:
			await runPluginOrThemeMode( php, options );
			break;
		case WPNowMode.PLAYGROUND:
			await runWpPlaygroundMode( php, options );
			break;
	}

	await mountInternalMuPlugins( php );
	await startSymlinkManager( php, options.projectPath, options.documentRoot );
	await setupPlatformLevelMuPlugins( php );
}

/**
 * Start the symlink manager
 *
 * The symlink manager ensures that we mount the targets of symlinks so that they
 * work inside the php runtime. It also watches for changes to ensure symlinks
 * are managed correctly.
 *
 * @param php
 * @param projectPath
 * @param documentRoot
 */
export async function startSymlinkManager( php: PHP, projectPath: string, documentRoot: string ) {
	// Symlink manager is not yet supported on windows
	// See: https://github.com/Automattic/studio/issues/548
	if ( process.platform === 'win32' ) {
		return;
	}

	const symlinkManager = new SymlinkManager( php, projectPath, documentRoot );
	await symlinkManager.scanAndCreateSymlinks();
	symlinkManager
		.startWatching()
		.catch( ( err ) => {
			output?.error( 'Error while watching for file changes', err );
		} )
		.finally( () => {
			output?.log( 'Stopped watching for file changes' );
		} );

	// Ensure that we stop watching for file changes when the runtime is exiting
	php.addEventListener( 'runtime.beforedestroy', () => {
		symlinkManager.stopWatching();
	} );
}

async function runIndexMode( php: PHP, { documentRoot, projectPath }: WPNowOptions ) {
	await php.mount(
		projectPath,
		createNodeFsMountHandler( documentRoot ) as unknown as MountHandler
	);
}

async function runWpContentMode(
	php: PHP,
	{ documentRoot, wordPressVersion, wpContentPath, projectPath, absoluteUrl }: WPNowOptions
) {
	const wordPressPath = path.join( getWordpressVersionsPath(), wordPressVersion );
	await php.mount(
		wordPressPath,
		createNodeFsMountHandler( documentRoot ) as unknown as MountHandler
	);
	await initWordPress( php, wordPressVersion, documentRoot, absoluteUrl );
	fs.ensureDirSync( wpContentPath );

	await php.mount(
		projectPath,
		createNodeFsMountHandler( `${ documentRoot }/wp-content` ) as unknown as MountHandler
	);

	await mountSqlitePlugin( php, documentRoot );
	await mountSqliteDatabaseDirectory( php, documentRoot, wpContentPath );
}

async function runWordPressDevelopMode(
	php: PHP,
	{ documentRoot, projectPath, absoluteUrl }: WPNowOptions
) {
	await runWordPressMode( php, {
		documentRoot,
		projectPath: projectPath + '/build',
		absoluteUrl,
	} );
}

async function runWordPressMode(
	php: PHP,
	{ documentRoot, projectPath, absoluteUrl }: WPNowOptions
) {
	php.mkdir( documentRoot );
	await php.mount(
		documentRoot,
		createNodeFsMountHandler( projectPath ) as unknown as MountHandler
	);

	await initWordPress( php, 'user-provided', documentRoot, absoluteUrl );
}

async function runPluginOrThemeMode(
	php: PHP,
	{ wordPressVersion, documentRoot, projectPath, wpContentPath, absoluteUrl, mode }: WPNowOptions
) {
	const wordPressPath = path.join( getWordpressVersionsPath(), wordPressVersion );
	await php.mount(
		wordPressPath,
		createNodeFsMountHandler( documentRoot ) as unknown as MountHandler
	);
	await initWordPress( php, wordPressVersion, documentRoot, absoluteUrl );

	fs.ensureDirSync( wpContentPath );
	fs.copySync(
		path.join( getWordpressVersionsPath(), wordPressVersion, 'wp-content' ),
		wpContentPath
	);
	await php.mount(
		wpContentPath,
		createNodeFsMountHandler( `${ documentRoot }/wp-content` ) as unknown as MountHandler
	);

	const pluginName = path.basename( projectPath );
	const directoryName = mode === WPNowMode.PLUGIN ? 'plugins' : 'themes';
	await php.mount(
		projectPath,
		createNodeFsMountHandler(
			`${ documentRoot }/wp-content/${ directoryName }/${ pluginName }`
		) as unknown as MountHandler
	);
	if ( mode === WPNowMode.THEME ) {
		const templateName = getThemeTemplate( projectPath );
		if ( templateName ) {
			// We assume that the theme template is in the parent directory
			const templatePath = path.join( projectPath, '..', templateName );
			if ( fs.existsSync( templatePath ) ) {
				await php.mount(
					templatePath,
					createNodeFsMountHandler(
						`${ documentRoot }/wp-content/${ directoryName }/${ templateName }`
					) as unknown as MountHandler
				);
			} else {
				output?.error( `Parent for child theme not found: ${ templateName }` );
			}
		}
	}
	await mountSqlitePlugin( php, documentRoot );
}

async function runWpPlaygroundMode(
	php: PHP,
	{ documentRoot, wordPressVersion, wpContentPath, absoluteUrl }: WPNowOptions
) {
	const wordPressPath = path.join( getWordpressVersionsPath(), wordPressVersion );
	await php.mount(
		wordPressPath,
		createNodeFsMountHandler( documentRoot ) as unknown as MountHandler
	);
	await initWordPress( php, wordPressVersion, documentRoot, absoluteUrl );

	fs.ensureDirSync( wpContentPath );
	fs.copySync(
		path.join( getWordpressVersionsPath(), wordPressVersion, 'wp-content' ),
		wpContentPath
	);
	await php.mount(
		wpContentPath,
		createNodeFsMountHandler( `${ documentRoot }/wp-content` ) as unknown as MountHandler
	);

	await mountSqlitePlugin( php, documentRoot );
}

async function login( php: PHP, options: WPNowOptions = {} ) {
	const { documentRoot } = options;

	await php.writeFile(
		`${ documentRoot }/playground-login.php`,
		`<?php
		require_once( dirname( __FILE__ ) . '/wp-load.php' );

		if ( is_user_logged_in() ) {
			return;
		}

		$user = get_user_by( 'login', 'admin' );

		if ( $user ) {
			wp_set_password( '${ options.adminPassword }', $user->ID );
		} else {
			$user_data = array(
				'user_login' => 'admin',
				'user_pass' => '${ options.adminPassword }',
				'user_email' => 'admin@localhost.com',
				'role' => 'administrator',
			);
			$user_id = wp_insert_user( $user_data );
			$user = get_user_by( 'id', $user_id );
		}

		wp_set_current_user( $user->ID, $user->user_login );
		wp_set_auth_cookie( $user->ID );
		do_action( 'wp_login', $user->user_login, $user );`
	);

	await php.requestHandler.request( {
		url: '/playground-login.php',
	} );

	await php.unlink( `${ documentRoot }/playground-login.php` );
}

/**
 * Initialize WordPress
 *
 * Initializes WordPress by copying sample config file to wp-config.php if it doesn't exist,
 * and sets up additional constants for PHP.
 *
 * It also returns information about whether the default database should be initialized.
 *
 * @param php
 * @param wordPressVersion
 * @param vfsDocumentRoot
 * @param siteUrl
 */
async function initWordPress(
	php: PHP,
	wordPressVersion: string,
	vfsDocumentRoot: string,
	siteUrl: string
) {
	let initializeDefaultDatabase = false;
	if ( ! php.fileExists( `${ vfsDocumentRoot }/wp-config.php` ) ) {
		php.writeFile(
			`${ vfsDocumentRoot }/wp-config.php`,
			php.readFileAsText( `${ vfsDocumentRoot }/wp-config-sample.php` )
		);
		initializeDefaultDatabase = true;
	}

	const wpConfigConsts = {
		WP_HOME: siteUrl,
		WP_SITEURL: siteUrl,
	};

	if ( wordPressVersion !== 'user-provided' ) {
		wpConfigConsts[ 'WP_AUTO_UPDATE_CORE' ] = wordPressVersion === 'latest';
	}
	await defineWpConfigConsts( php, {
		consts: wpConfigConsts,
		method: 'define-before-run',
	} );

	return { initializeDefaultDatabase };
}

async function activatePluginOrTheme( php: PHP, { projectPath, mode }: WPNowOptions ) {
	if ( mode === WPNowMode.PLUGIN ) {
		const pluginFile = getPluginFile( projectPath );
		await activatePlugin( php, { pluginPath: pluginFile } );
	} else if ( mode === WPNowMode.THEME ) {
		const themeFolderName = path.basename( projectPath );
		await activateTheme( php, { themeFolderName } );
	}
}

export function getThemeTemplate( projectPath: string ) {
	const themeTemplateRegex = /^(?:[ \t]*<\?php)?[ \t/*#@]*Template:(.*)$/im;
	const styleCSS = readFileHead( path.join( projectPath, 'style.css' ) );
	if ( themeTemplateRegex.test( styleCSS ) ) {
		const themeName = themeTemplateRegex.exec( styleCSS )[ 1 ].trim();
		return themeName;
	}
}

async function mountInternalMuPlugins( php: PHP ) {
	php.mkdir( PLAYGROUND_INTERNAL_MU_PLUGINS_FOLDER );

	php.writeFile(
		path.posix.join( PLAYGROUND_INTERNAL_MU_PLUGINS_FOLDER, '0-allowed-redirect-hosts.php' ),
		`<?php
	// Needed because gethostbyname( <host> ) returns
	// a private network IP address for some reason.
	add_filter( 'allowed_redirect_hosts', function( $hosts ) {
		$redirect_hosts = array(
			'wordpress.org',
			'api.wordpress.org',
			'downloads.wordpress.org',
			'themes.svn.wordpress.org',
			'fonts.gstatic.com',
		);
		return array_merge( $hosts, $redirect_hosts );
	} );
	add_filter('http_request_host_is_external', '__return_true', 20, 3 );
	`
	);

	php.writeFile(
		path.posix.join( PLAYGROUND_INTERNAL_MU_PLUGINS_FOLDER, '0-thumbnails.php' ),
		`<?php
		// Facilitates the taking of screenshots to be used as thumbnails.
		if ( isset( $_GET['studio-hide-adminbar'] ) ) {
			add_filter( 'show_admin_bar', '__return_false' );
		}
		`
	);

	php.writeFile(
		path.posix.join( PLAYGROUND_INTERNAL_MU_PLUGINS_FOLDER, '0-32bit-integer-warnings.php' ),
		`<?php
/**
 * This is a temporary workaround to hide the 32bit integer warnings that
 * appear when using various time related function, such as strtotime and mktime.
 * Examples of the warnings that are displayed:
 * Warning: mktime(): Epoch doesn't fit in a PHP integer in <file>
 * Warning: strtotime(): Epoch doesn't fit in a PHP integer in <file>
 */
set_error_handler(function($severity, $message, $file, $line) {
  if (strpos($message, "fit in a PHP integer") !== false) {
      return;
  }
  return false;
});
`
	);

	php.writeFile(
		path.posix.join( PLAYGROUND_INTERNAL_MU_PLUGINS_FOLDER, '0-check-theme-availability.php' ),
		`<?php
	function check_current_theme_availability() {
			// Get the current theme's directory
			$current_theme = wp_get_theme();
			$theme_dir = get_theme_root() . '/' . $current_theme->stylesheet;

			if (!is_dir($theme_dir)) {
					$all_themes = wp_get_themes();
					$available_themes = [];

					foreach ($all_themes as $theme_slug => $theme_obj) {
							if ($theme_slug != $current_theme->get_stylesheet()) {
									$available_themes[$theme_slug] = $theme_obj;
							}
					}

					if (!empty($available_themes)) {
							$new_theme_slug = array_keys($available_themes)[0];
							switch_theme($new_theme_slug);
					}
			}
	}
	add_action('after_setup_theme', 'check_current_theme_availability');
`
	);

	php.writeFile(
		path.posix.join( PLAYGROUND_INTERNAL_MU_PLUGINS_FOLDER, '0-permalinks.php' ),
		`<?php
			// Support permalinks without "index.php"
			add_filter( 'got_url_rewrite', '__return_true' );
	`
	);

	php.writeFile(
		path.posix.join( PLAYGROUND_INTERNAL_MU_PLUGINS_FOLDER, '0-sqlite-command.php' ),
		`<?php
			add_filter( 'sqlite_command_sqlite_plugin_directories', function( $directories ) {
				$directories[] = ${ phpVar( SQLITE_PLUGIN_FOLDER ) };
				return $directories;
			} );
		`
	);

	php.writeFile(
		path.posix.join( PLAYGROUND_INTERNAL_MU_PLUGINS_FOLDER, '0-deactivate-jetpack-modules.php' ),
		`<?php
			// Disable Jetpack Protect 2FA for local auto-login purpose
			add_action( 'jetpack_active_modules', 'jetpack_deactivate_modules' );
			function jetpack_deactivate_modules( $active ) {
				if ( ( $index = array_search('protect', $active, true) ) !== false ) {
					unset( $active[ $index ] );
				}
				return $active;
			}
	`
	);

	php.writeFile(
		path.posix.join( PLAYGROUND_INTERNAL_MU_PLUGINS_FOLDER, '0-wp-config-constants-polyfill.php' ),
		`<?php
		// Define database constants if not already defined. It fixes the error
		// for imported sites that don't have those defined e.g. WP Cloud and
		// include plugins which try to access those directly e.g. Mailpoet
		if (!defined('DB_NAME')) define('DB_NAME', 'database_name_here');
		if (!defined('DB_USER')) define('DB_USER', 'username_here');
		if (!defined('DB_PASSWORD')) define('DB_PASSWORD', 'password_here');
		if (!defined('DB_HOST')) define('DB_HOST', 'localhost');
		if (!defined('DB_CHARSET')) define('DB_CHARSET', 'utf8');
		if (!defined('DB_COLLATE')) define('DB_COLLATE', '');
		`
	);
}

async function mountSqlitePlugin( php: PHP, vfsDocumentRoot: string ) {
	const sqlitePluginPath = `${ vfsDocumentRoot }/wp-content/plugins/${ SQLITE_FILENAME }`;
	if ( php.listFiles( sqlitePluginPath ).length === 0 ) {
		await php.mount(
			getSqlitePath(),
			createNodeFsMountHandler( sqlitePluginPath ) as unknown as MountHandler
		);
		await php.mount(
			path.join( getSqlitePath(), 'db.copy' ),
			createNodeFsMountHandler(
				`${ vfsDocumentRoot }/wp-content/db.php`
			) as unknown as MountHandler
		);
	}
}

/**
 * Create SQLite database directory in hidden utility directory and mount it to the document root
 *
 * @param php
 * @param vfsDocumentRoot
 * @param wpContentPath
 */
async function mountSqliteDatabaseDirectory(
	php: PHP,
	vfsDocumentRoot: string,
	wpContentPath: string
) {
	fs.ensureDirSync( path.join( wpContentPath, 'database' ) );
	await php.mount(
		path.join( wpContentPath, 'database' ),
		createNodeFsMountHandler(
			`${ vfsDocumentRoot }/wp-content/database`
		) as unknown as MountHandler
	);
}

export function inferMode( projectPath: string ): Exclude< WPNowMode, WPNowMode.AUTO > {
	if ( isWordPressDevelopDirectory( projectPath ) ) {
		return WPNowMode.WORDPRESS_DEVELOP;
	} else if ( isWordPressDirectory( projectPath ) ) {
		return WPNowMode.WORDPRESS;
	} else if ( isWpContentDirectory( projectPath ) ) {
		return WPNowMode.WP_CONTENT;
	} else if ( isPluginDirectory( projectPath ) ) {
		return WPNowMode.PLUGIN;
	} else if ( isThemeDirectory( projectPath ) ) {
		return WPNowMode.THEME;
	} else if ( hasIndexFile( projectPath ) ) {
		return WPNowMode.INDEX;
	}
	return WPNowMode.PLAYGROUND;
}

async function installationSteps( php: PHP, options: WPNowOptions ) {
	const siteLanguage = options.siteLanguage;

	const executeStep = async ( step: 0 | 1 | 2 ) => {
		return php.requestHandler.request( {
			url: `/wp-admin/install.php?step=${ step }`,
			method: 'POST',
			body:
				step === 2
					? {
							language: siteLanguage,
							prefix: 'wp_',
							weblog_title: options.siteTitle,
							user_name: 'admin',
							admin_password: options.adminPassword,
							admin_password2: options.adminPassword,
							Submit: 'Install WordPress',
							pw_weak: '1',
							admin_email: 'admin@localhost.com',
					  }
					: {
							language: siteLanguage,
					  },
		} );
	};
	// First two steps are needed to download and set translations
	await executeStep( 0 );
	await executeStep( 1 );

	// Set up site details
	await executeStep( 2 );
}

export async function moveDatabasesInSitu( projectPath: string ) {
	const dbPhpPath = path.join( projectPath, 'wp-content', 'db.php' );
	const hasDbPhpInSitu = fs.existsSync( dbPhpPath ) && fs.lstatSync( dbPhpPath ).isFile();

	const { wpContentPath } = await getWpNowConfig( { path: projectPath } );
	if (
		wpContentPath &&
		fs.existsSync( path.join( wpContentPath, 'database' ) ) &&
		! hasDbPhpInSitu
	) {
		// Do not mount but move the files to projectPath once
		const databasePath = path.join( projectPath, 'wp-content', 'database' );
		fs.rmdirSync( databasePath );
		fs.moveSync( path.join( wpContentPath, 'database' ), databasePath );

		const sqlitePath = path.join( projectPath, 'wp-content', 'plugins', SQLITE_FILENAME );
		fs.rmdirSync( sqlitePath );
		fs.copySync( path.join( getSqlitePath() ), sqlitePath );

		fs.rmdirSync( dbPhpPath );
		fs.copySync( path.join( getSqlitePath(), 'db.copy' ), dbPhpPath );
		fs.rmSync( wpContentPath, { recursive: true, force: true } );
	}
}

/**
 * The default `umask` set by Emscripten is 0777 which is too restrictive. This has been updated
 * in https://github.com/emscripten-core/emscripten/pull/22589 but is not available in the stable
 * version of Emscripten yet. In the meantime, we'll apply a workaround by setting the umask via
 * a preload file that will be executed before running any PHP file.
 *
 * Once the Emscripten update is available, a new version of Playground is released using the
 * updated Emscripten, and the Playground dependency is updated in the app, this workaround can be removed.
 */
function applyOverrideUmaskWorkaround( php: PHP ) {
	php.writeFile(
		path.posix.join( PLAYGROUND_INTERNAL_PRELOAD_PATH, 'override-umask-workaround.php' ),
		'<?php umask(0022);'
	);
}
