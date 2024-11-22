import { Icon, SearchControl as SearchControlWp } from '@wordpress/components';
import { __, sprintf } from '@wordpress/i18n';
import { useI18n } from '@wordpress/react-i18n';
import { useState, useEffect } from 'react';
import { SyncSite } from '../hooks/use-fetch-wpcom-sites';
import { useOffline } from '../hooks/use-offline';
import { cx } from '../lib/cx';
import { getIpcApi } from '../lib/get-ipc-api';
import { Badge } from './badge';
import Button from './button';
import Modal from './modal';
import offlineIcon from './offline-icon';
import { WordPressShortLogo } from './wordpress-short-logo';

const SearchControl = process.env.NODE_ENV === 'test' ? () => null : SearchControlWp;

export function SyncSitesModalSelector( {
	isLoading,
	onRequestClose,
	onConnect,
	syncSites,
	onInitialRender,
}: {
	isLoading?: boolean;
	onRequestClose: () => void;
	syncSites: SyncSite[];
	onConnect: ( siteId: number ) => void;
	onInitialRender?: () => void;
} ) {
	const { __ } = useI18n();
	const [ selectedSiteId, setSelectedSiteId ] = useState< number | null >( null );
	const [ searchQuery, setSearchQuery ] = useState< string >( '' );
	const isOffline = useOffline();
	const filteredSites = syncSites.filter( ( site ) => {
		const searchQueryLower = searchQuery.toLowerCase();
		return (
			site.name?.toLowerCase().includes( searchQueryLower ) ||
			site.url?.toLowerCase().includes( searchQueryLower )
		);
	} );
	const isEmpty = filteredSites.length === 0;

	useEffect( () => {
		if ( onInitialRender ) {
			onInitialRender();
		}
	}, [ onInitialRender ] );

	return (
		<Modal
			className="w-3/5 min-w-[550px] h-full max-h-[84vh] [&>div]:!p-0"
			onRequestClose={ onRequestClose }
			title={ __( 'Connect a WordPress.com site' ) }
		>
			<div className="relative">
				<SearchSites searchQuery={ searchQuery } setSearchQuery={ setSearchQuery } />
				<div className="h-[calc(84vh-232px)]">
					{ isLoading && (
						<div className="flex justify-center items-center h-full">
							{ __( 'Loading sites…' ) }
						</div>
					) }

					{ ! isLoading && isEmpty && (
						<div className="flex justify-center items-center h-full">
							{ searchQuery
								? sprintf( __( 'No sites found for "%s"' ), searchQuery )
								: __( 'No sites found' ) }
						</div>
					) }

					{ ! isLoading && ! isEmpty && (
						<ListSites
							syncSites={ filteredSites }
							selectedSiteId={ selectedSiteId }
							onSelectSite={ setSelectedSiteId }
						/>
					) }
				</div>
				<Footer
					onRequestClose={ onRequestClose }
					onConnect={ () => {
						if ( ! selectedSiteId ) {
							return;
						}
						onConnect( selectedSiteId );
						onRequestClose();
					} }
					disabled={ ! selectedSiteId }
				/>

				{ isOffline && (
					<div className="absolute inset-0 bg-white/80 z-10 flex items-center justify-center">
						<SyncSitesOfflineView />
					</div>
				) }
			</div>
		</Modal>
	);
}

function SearchSites( {
	searchQuery,
	setSearchQuery,
}: {
	searchQuery: string;
	setSearchQuery: ( value: string ) => void;
} ) {
	const { __ } = useI18n();
	return (
		<div className="flex flex-col px-8 pb-6 border-b border-a8c-gray-5">
			<SearchControl
				className="w-full mt-0.5"
				placeholder={ __( 'Search sites' ) }
				onChange={ ( value ) => {
					setSearchQuery( value );
				} }
				value={ searchQuery }
				autoFocus
			/>
			<p className="a8c-helper-text text-gray-500">
				{ __( 'Syncing is supported for sites on the Business plan or above.' ) }
			</p>
		</div>
	);
}

const getSortedSites = ( sites: SyncSite[] ) => {
	const order: Record< SyncSite[ 'syncSupport' ], number > = {
		syncable: 1,
		'already-connected': 2,
		'needs-transfer': 3,
		unsupported: 4,
		'jetpack-site': 5,
	};

	return [ ...sites ].sort( ( a, b ) => order[ a.syncSupport ] - order[ b.syncSupport ] );
};

function ListSites( {
	syncSites,
	selectedSiteId,
	onSelectSite,
}: {
	syncSites: SyncSite[];
	selectedSiteId: null | number;
	onSelectSite: ( id: number ) => void;
} ) {
	const sortedSites = getSortedSites( syncSites );

	return (
		<div className="flex flex-col overflow-y-auto h-full">
			{ sortedSites.map( ( site ) => (
				<SiteItem
					key={ site.id }
					site={ site }
					isSelected={ site.id === selectedSiteId }
					onClick={ () => onSelectSite( site.id ) }
				/>
			) ) }
		</div>
	);
}

function SiteItem( {
	site,
	isSelected,
	onClick,
}: {
	site: SyncSite;
	isSelected: boolean;
	onClick: () => void;
} ) {
	const { __ } = useI18n();
	if ( site.isStaging ) {
		return null;
	}
	const isAlreadyConnected = site.syncSupport === 'already-connected';
	const isSyncable = site.syncSupport === 'syncable';
	const isNeedsTransfer = site.syncSupport === 'needs-transfer';
	const isUnsupported = site.syncSupport === 'unsupported';
	const isJetpackSite = site.syncSupport === 'jetpack-site';
	return (
		<div
			className={ cx(
				'flex py-3 px-8 items-center border-b border-a8c-gray-0 justify-between gap-4',
				isSelected && 'bg-a8c-blueberry text-white',
				! isSelected && isSyncable && 'hover:bg-a8c-blueberry-5'
			) }
			role={ isSyncable ? 'button' : undefined }
			onClick={ () => {
				if ( ! isSyncable ) {
					return;
				}
				onClick();
			} }
		>
			<div className="flex flex-col gap-0.5 overflow-hidden">
				<div className={ cx( 'a8c-body truncate', ! isSyncable && 'text-a8c-gray-30' ) }>
					{ site.name }
				</div>
				<div
					className={ cx( 'a8c-body-small text-a8c-gray-30 truncate', isSelected && 'text-white' ) }
				>
					{ site.url.replace( /^https?:\/\//, '' ) }
				</div>
			</div>
			{ isSyncable && (
				<div className="flex gap-2">
					<Badge
						className={ cx(
							isSelected
								? 'bg-white text-a8c-blueberry text-a8c-blueberry'
								: 'bg-a8c-green-5 text-a8c-green-80'
						) }
					>
						{ __( 'Production' ) }
					</Badge>
					{ site.stagingSiteIds.length > 0 && (
						<Badge
							className={ cx( isSelected && 'bg-white text-a8c-blueberry text-a8c-blueberry' ) }
						>
							{ __( 'Staging' ) }
						</Badge>
					) }
				</div>
			) }
			{ isAlreadyConnected && (
				<div className="a8c-body-small text-a8c-gray-30 shrink-0">
					{ __( 'Already connected' ) }
				</div>
			) }
			{ isUnsupported && (
				<div className="a8c-body-small text-a8c-gray-30 shrink-0 text-right">
					<Button
						variant="link"
						onClick={ () => getIpcApi().openURL( `https://wordpress.com/plans/${ site.id }` ) }
					>
						{ __( 'Upgrade plan ↗' ) }
					</Button>
				</div>
			) }
			{ isNeedsTransfer && (
				<div className="a8c-body-small text-a8c-gray-30 shrink-0 text-right">
					<Button
						variant="link"
						onClick={ () =>
							getIpcApi().openURL( `https://wordpress.com/hosting-features/${ site.id }` )
						}
					>
						{ __( 'Enable hosting features ↗' ) }
					</Button>
				</div>
			) }
			{ isJetpackSite && (
				<div className="a8c-body-small text-a8c-gray-30 shrink-0">{ __( 'Unsupported site' ) }</div>
			) }
		</div>
	);
}

function Footer( {
	onRequestClose,
	onConnect,
	disabled,
}: {
	onRequestClose: () => void;
	onConnect: () => void;
	disabled: boolean;
} ) {
	const { __ } = useI18n();
	return (
		<div className="flex px-8 py-4 border-t border-a8c-gray-5 justify-between">
			<Button
				variant="link"
				className="flex items-center mb-1"
				onClick={ () => getIpcApi().openURL( 'https://wordpress.com/hosting/' ) }
			>
				<div className="a8c-subtitle-small text-black">{ __( 'Powered by' ) }</div>
				<WordPressShortLogo className="h-4.5" />
			</Button>
			<div className="flex gap-4">
				<Button variant="link" onClick={ onRequestClose }>
					{ __( 'Cancel' ) }
				</Button>
				<Button variant="primary" disabled={ disabled } onClick={ onConnect }>
					{ __( 'Connect' ) }
				</Button>
			</div>
		</div>
	);
}

const SyncSitesOfflineView = () => {
	const offlineMessage = __( 'Connecting a site requires an internet connection.' );

	return (
		<div className="flex items-center justify-center h-12 px-2 pt-4 text-a8c-gray-70 gap-1">
			<Icon className="m-1 fill-a8c-gray-70" size={ 24 } icon={ offlineIcon } />
			<span className="text-[13px] leading-[16px]">{ offlineMessage }</span>
		</div>
	);
};
