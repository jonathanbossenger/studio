export function CheckIcon( props: { className?: string; size?: number } ) {
	const { className, size = 14 } = props;
	return (
		<svg
			className={ className || 'fill-current' }
			width={ size }
			height={ size }
			viewBox="0 0 14 14"
			fill="none"
			xmlns="http://www.w3.org/2000/svg"
		>
			<path
				fillRule="evenodd"
				clipRule="evenodd"
				d="M7.00016 12.4154C5.56357 12.4154 4.18582 11.8447 3.17 10.8289C2.15418 9.81304 1.5835 8.43529 1.5835 6.9987C1.5835 5.56211 2.15418 4.18436 3.17 3.16854C4.18582 2.15271 5.56357 1.58203 7.00016 1.58203C8.43675 1.58203 9.8145 2.15271 10.8303 3.16854C11.8461 4.18436 12.4168 5.56211 12.4168 6.9987C12.4168 8.43529 11.8461 9.81304 10.8303 10.8289C9.8145 11.8447 8.43675 12.4154 7.00016 12.4154ZM0.333496 6.9987C0.333496 5.23059 1.03588 3.5349 2.28612 2.28465C3.53636 1.03441 5.23205 0.332031 7.00016 0.332031C8.76827 0.332031 10.464 1.03441 11.7142 2.28465C12.9645 3.5349 13.6668 5.23059 13.6668 6.9987C13.6668 8.76681 12.9645 10.4625 11.7142 11.7127C10.464 12.963 8.76827 13.6654 7.00016 13.6654C5.23205 13.6654 3.53636 12.963 2.28612 11.7127C1.03588 10.4625 0.333496 8.76681 0.333496 6.9987ZM9.94183 5.7737L9.0585 4.89036L6.16683 7.78203L4.94183 6.55703L4.0585 7.44036L6.16683 9.5487L9.94183 5.7737Z"
			/>
		</svg>
	);
}
