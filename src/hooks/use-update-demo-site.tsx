import * as Sentry from '@sentry/electron/renderer';
import { sprintf } from '@wordpress/i18n';
import { useI18n } from '@wordpress/react-i18n';
import { useCallback, useState, createContext, useContext, useMemo, ReactNode } from 'react';
import { DEMO_SITE_SIZE_LIMIT_BYTES, DEMO_SITE_SIZE_LIMIT_GB } from '../constants';
import { getIpcApi } from '../lib/get-ipc-api';
import { useAuth } from './use-auth';
import { useFeatureFlags } from './use-feature-flags';
import { useSnapshots } from './use-snapshots';

interface DemoSiteUpdateContextType {
	updateDemoSite: ( snapshot: Snapshot, localSite: SiteDetails ) => Promise< void >;
	isDemoSiteUpdating: ( atomicSiteId: number ) => boolean;
}

const DemoSiteUpdateContext = createContext< DemoSiteUpdateContextType >( {
	updateDemoSite: async () => undefined,
	isDemoSiteUpdating: () => false,
} );

interface DemoSiteUpdateProviderProps {
	children: ReactNode;
}

export const DemoSiteUpdateProvider: React.FC< DemoSiteUpdateProviderProps > = ( { children } ) => {
	const { client } = useAuth();
	const { __ } = useI18n();
	const [ updatingSites, setUpdatingSites ] = useState< Set< number > >( new Set() );
	const { updateSnapshot } = useSnapshots();
	const { quickDeploysEnabled } = useFeatureFlags();

	const updateDemoSite = useCallback(
		async ( snapshot: Snapshot, localSite: SiteDetails ) => {
			if ( ! client ) {
				// No-op if logged out
				return;
			}
			setUpdatingSites( ( prev ) => new Set( prev ).add( snapshot.atomicSiteId ) );

			let archivePath = '';
			try {
				const { archivePath: tempArchivePath, archiveSizeInBytes } = await getIpcApi().archiveSite(
					localSite.id,
					'zip'
				);
				archivePath = tempArchivePath;

				if ( archiveSizeInBytes > DEMO_SITE_SIZE_LIMIT_BYTES ) {
					getIpcApi().showErrorMessageBox( {
						title: quickDeploysEnabled
							? __( 'Updating preview site failed' )
							: __( 'Updating demo site failed' ),
						message: sprintf(
							__(
								'The site exceeds the maximum size of %dGB. Please remove some files and try again.'
							),
							DEMO_SITE_SIZE_LIMIT_GB
						),
					} );

					setUpdatingSites( ( prev ) => {
						const newSet = new Set( prev );
						newSet.delete( snapshot.atomicSiteId );
						return newSet;
					} );
					getIpcApi().removeTemporalFile( archivePath );
					return;
				}

				const file = new File(
					[ await getIpcApi().getFileContent( archivePath ) ],
					'loca-env-site-1.zip',
					{
						type: 'application/zip',
					}
				);

				const formData = [
					[ 'site_id', snapshot.atomicSiteId ],
					[ 'import', file ],
				];

				const wordpressVersion = await getIpcApi().getWpVersion( localSite.id );
				if ( wordpressVersion.length >= 3 ) {
					formData.push( [ 'wordpress_version', wordpressVersion ] );
				}

				const response = await client.req.post( {
					path: '/jurassic-ninja/update-site-from-zip',
					apiNamespace: 'wpcom/v2',
					formData,
				} );
				updateSnapshot( {
					...snapshot,
					date: new Date().getTime(),
				} );
				await getIpcApi().showNotification( {
					title: __( 'Update Successful' ),
					body: quickDeploysEnabled
						? sprintf( __( "Preview site for '%s' has been updated." ), localSite.name )
						: sprintf( __( "Demo site for '%s' has been updated." ), localSite.name ),
				} );
				return response;
			} catch ( error ) {
				getIpcApi().showErrorMessageBox( {
					title: __( 'Update failed' ),
					message: quickDeploysEnabled
						? sprintf(
								__( "We couldn't update the %s preview site. Please try again." ),
								localSite.name
						  )
						: sprintf(
								__( "We couldn't update the %s demo site. Please try again." ),
								localSite.name
						  ),
					error,
				} );
				Sentry.captureException( error );
			} finally {
				setUpdatingSites( ( prev ) => {
					const next = new Set( prev );
					next.delete( snapshot.atomicSiteId );
					return next;
				} );
				if ( archivePath ) {
					getIpcApi().removeTemporalFile( archivePath );
				}
			}
		},
		[ __, client, updateSnapshot, quickDeploysEnabled ]
	);

	const isDemoSiteUpdating = useCallback(
		( atomicSiteId: number ) => {
			return updatingSites.has( atomicSiteId );
		},
		[ updatingSites ]
	);

	const contextValue = useMemo(
		() => ( {
			updateDemoSite,
			isDemoSiteUpdating,
		} ),
		[ updateDemoSite, isDemoSiteUpdating ]
	);

	return (
		<DemoSiteUpdateContext.Provider value={ contextValue }>
			{ children }
		</DemoSiteUpdateContext.Provider>
	);
};

export const useUpdateDemoSite = () => {
	const context = useContext( DemoSiteUpdateContext );
	if ( context === null ) {
		throw new Error( 'useDemoSiteUpdate must be used within a DemoSiteUpdateProvider' );
	}
	return context;
};
