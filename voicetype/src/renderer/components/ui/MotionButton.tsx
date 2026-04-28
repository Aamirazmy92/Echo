import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '../../lib/utils';

type MotionButtonProps = ButtonHTMLAttributes<HTMLButtonElement>;

const MotionButton = forwardRef<HTMLButtonElement, MotionButtonProps>(function MotionButton(
  { type = 'button', className, ...props },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn('transition-transform duration-100 active:scale-[0.98]', className)}
      {...props}
    />
  );
});

export default MotionButton;
