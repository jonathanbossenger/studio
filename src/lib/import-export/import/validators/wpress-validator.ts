import { EventEmitter } from 'events';
import path from 'path';
import { ImportEvents } from '../events';
import { BackupContents } from '../types';
import { Validator } from './validator';

export class WpressValidator extends EventEmitter implements Validator {
	canHandle( fileList: string[] ): boolean {
		const requiredFiles = [ 'database.sql', 'package.json' ];
		const optionalDirs = [ 'uploads', 'plugins', 'themes' ];
		return (
			requiredFiles.every( ( file ) => fileList.includes( file ) ) &&
			optionalDirs.some( ( dir ) => fileList.some( ( file ) => file.startsWith( dir + path.sep ) ) )
		);
	}

	parseBackupContents( fileList: string[], extractionDirectory: string ): BackupContents {
		this.emit( ImportEvents.IMPORT_VALIDATION_START );
		const extractedBackup: BackupContents = {
			extractionDirectory,
			sqlFiles: [],
			wpConfig: '',
			wpContent: {
				uploads: [],
				plugins: [],
				themes: [],
				muPlugins: [],
			},
			wpContentDirectory: '',
		};
		/* File rules:
		 * - Accept .wpress
		 * - Must include database.sql in the root
		 * - Support optional directories: uploads, plugins, themes, mu-plugins
		 * */

		for ( const file of fileList ) {
			const fullPath = path.join( extractionDirectory, file );
			if ( file === 'database.sql' ) {
				extractedBackup.sqlFiles.push( fullPath );
			} else if ( file.startsWith( 'uploads' + path.sep ) ) {
				extractedBackup.wpContent.uploads.push( fullPath );
			} else if ( file.startsWith( 'plugins' + path.sep ) ) {
				extractedBackup.wpContent.plugins.push( fullPath );
			} else if ( file.startsWith( 'themes' + path.sep ) ) {
				extractedBackup.wpContent.themes.push( fullPath );
			} else if ( file.startsWith( 'mu-plugins' + path.sep ) ) {
				extractedBackup.wpContent.muPlugins!.push( fullPath );
			} else if ( file === 'package.json' ) {
				extractedBackup.metaFile = fullPath;
			}
		}
		extractedBackup.sqlFiles.sort( ( a: string, b: string ) =>
			path.basename( a ).localeCompare( path.basename( b ) )
		);

		this.emit( ImportEvents.IMPORT_VALIDATION_COMPLETE );
		return extractedBackup;
	}
}
